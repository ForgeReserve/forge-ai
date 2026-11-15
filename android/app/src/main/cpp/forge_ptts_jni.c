// JNI glue between the app's Kotlin (PttsNative.kt) and Gradium's C interface to Phonon
// (libptts_ffi.so, ptts-ffi/include/ptts.h in github.com/gradium-ai/xn-ptts). Built by
// scripts/android-ptts.sh with the NDK's clang against the pinned checkout, and committed with
// libptts_ffi.so in jniLibs/arm64-v8a: the Gradle build compiles no native code, so it needs no NDK
// and no Rust. Used in place of JNA (the upstream Kotlin wrapper's route): a few calls, no reflection,
// no extra library for every ABI.
//
// Strings come in as UTF-8 bytes (Kotlin's encodeToByteArray), not as jstring: JNI's "modified UTF-8"
// would mangle an emoji in an answer. Errors become an IllegalStateException with the library's own
// words. The sound goes to PcmSink.onPcm(float[]) on the thread that called speak, as ptts_speak
// calls back on its caller's thread.
#define _GNU_SOURCE
#include <errno.h>
#include <jni.h>
#include <sched.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "ptts.h"

static void throw_state(JNIEnv *env, const char *msg) {
    if ((*env)->ExceptionCheck(env)) return;
    jclass c = (*env)->FindClass(env, "java/lang/IllegalStateException");
    if (c) (*env)->ThrowNew(env, c, msg && *msg ? msg : "the voice library failed and said nothing");
}

/** A Java byte[] as a NUL-terminated C string (malloc'd), or NULL with an exception set. */
static char *c_string(JNIEnv *env, jbyteArray bytes) {
    if (!bytes) {
        throw_state(env, "missing string");
        return NULL;
    }
    jsize n = (*env)->GetArrayLength(env, bytes);
    char *s = malloc((size_t)n + 1);
    if (!s) {
        throw_state(env, "out of memory");
        return NULL;
    }
    (*env)->GetByteArrayRegion(env, bytes, 0, n, (jbyte *)s);
    s[n] = 0;
    return s;
}

static PttsHandle *handle(jlong h) { return (PttsHandle *)(intptr_t)h; }

JNIEXPORT jlong JNICALL Java_com_forgereserve_ai_PttsNative_open(JNIEnv *env, jclass cls, jbyteArray dir, jbyteArray lang) {
    char *d = c_string(env, dir);
    if (!d) return 0;
    char *l = c_string(env, lang);
    if (!l) {
        free(d);
        return 0;
    }
    PttsHandle *h = ptts_new(d, PTTS_UNIT_CPU, l);
    free(d);
    free(l);
    if (!h) throw_state(env, ptts_last_error(NULL));
    return (jlong)(intptr_t)h;
}

/** The voice names, one per line. */
JNIEXPORT jstring JNICALL Java_com_forgereserve_ai_PttsNative_voices(JNIEnv *env, jclass cls, jlong h) {
    const char *block = ptts_voices(handle(h));
    size_t total = 0;
    for (const char *p = block; *p; p += strlen(p) + 1) total += strlen(p) + 1;
    char *out = malloc(total + 1);
    if (!out) {
        throw_state(env, "out of memory");
        return NULL;
    }
    size_t at = 0;
    for (const char *p = block; *p; p += strlen(p) + 1) {
        size_t n = strlen(p);
        memcpy(out + at, p, n);
        at += n;
        out[at++] = '\n';
    }
    if (at) at--;
    out[at] = 0;
    jstring s = (*env)->NewStringUTF(env, out);
    free(out);
    return s;
}

JNIEXPORT void JNICALL Java_com_forgereserve_ai_PttsNative_setVoice(JNIEnv *env, jclass cls, jlong h, jbyteArray name) {
    char *n = c_string(env, name);
    if (!n) return;
    bool ok = ptts_set_voice(handle(h), n);
    free(n);
    if (!ok) throw_state(env, ptts_last_error(handle(h)));
}

JNIEXPORT void JNICALL Java_com_forgereserve_ai_PttsNative_setTemperature(JNIEnv *env, jclass cls, jlong h, jfloat t) {
    if (!ptts_set_temperature(handle(h), t)) throw_state(env, ptts_last_error(handle(h)));
}

JNIEXPORT void JNICALL Java_com_forgereserve_ai_PttsNative_setSeed(JNIEnv *env, jclass cls, jlong h, jlong seed) {
    ptts_set_seed(handle(h), (uint64_t)seed);
}

typedef struct {
    JNIEnv *env;
    jobject sink;
    jmethodID on_pcm;
    bool failed;  // a Java exception is pending: stop, and let it reach the caller
} Speak;

static bool on_frame(const float *pcm, size_t n, void *user) {
    Speak *s = user;
    JNIEnv *env = s->env;
    jfloatArray a = (*env)->NewFloatArray(env, (jsize)n);
    if (!a) {
        s->failed = true;
        return false;
    }
    (*env)->SetFloatArrayRegion(env, a, 0, (jsize)n, pcm);
    jboolean go = (*env)->CallBooleanMethod(env, s->sink, s->on_pcm, a);
    (*env)->DeleteLocalRef(env, a);
    if ((*env)->ExceptionCheck(env)) {
        s->failed = true;
        return false;
    }
    return go == JNI_TRUE;
}

/**
 * Speaks text, handing each piece of sound to sink.onPcm(float[]) (24 kHz mono, -1 to 1); onPcm
 * returns false to stop. timings gets {frames, samples, ttfaMs, totalMs}. A sink exception is
 * rethrown; a library failure throws IllegalStateException.
 */
JNIEXPORT void JNICALL Java_com_forgereserve_ai_PttsNative_speak(JNIEnv *env, jclass cls, jlong h, jbyteArray text, jobject sink, jdoubleArray timings) {
    char *t = c_string(env, text);
    if (!t) return;
    jclass sc = (*env)->GetObjectClass(env, sink);
    jmethodID m = sc ? (*env)->GetMethodID(env, sc, "onPcm", "([F)Z") : NULL;
    if (!m) {
        free(t);
        return;  // NoSuchMethodError is pending
    }
    Speak s = {env, sink, m, false};
    PttsResult r = {0};
    bool ok = ptts_speak(handle(h), t, on_frame, &s, &r);
    free(t);
    if (s.failed) return;
    if (!ok) {
        throw_state(env, ptts_last_error(handle(h)));
        return;
    }
    if (timings && (*env)->GetArrayLength(env, timings) >= 4) {
        jdouble v[4] = {(jdouble)r.frames, (jdouble)r.samples, r.ttfa_ms, r.total_ms};
        (*env)->SetDoubleArrayRegion(env, timings, 0, 4, v);
    }
}

JNIEXPORT void JNICALL Java_com_forgereserve_ai_PttsNative_free(JNIEnv *env, jclass cls, jlong h) {
    if (h) ptts_free(handle(h));
}

/**
 * Keeps the calling thread, and every thread it starts from now on (the model's workers among them),
 * on these CPUs. Returns 0, or the errno when the system refused.
 */
JNIEXPORT jint JNICALL Java_com_forgereserve_ai_PttsNative_pin(JNIEnv *env, jclass cls, jintArray cpus) {
    jsize n = (*env)->GetArrayLength(env, cpus);
    jint ids[CPU_SETSIZE];
    if (n <= 0 || n > CPU_SETSIZE) return EINVAL;
    (*env)->GetIntArrayRegion(env, cpus, 0, n, ids);
    cpu_set_t set;
    CPU_ZERO(&set);
    for (jsize i = 0; i < n; i++)
        if (ids[i] >= 0 && ids[i] < CPU_SETSIZE) CPU_SET(ids[i], &set);
    return sched_setaffinity(0, sizeof set, &set) == 0 ? 0 : errno;
}
