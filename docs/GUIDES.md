# Guides

Status: design proposal, written 2026-11-17. Nothing on this page is built. It rethinks the `guides` kind in [MODULES.md](MODULES.md) and slice A8 in [ROADMAP.md](ROADMAP.md), for the hackathon.

## What an organizational brain is

Alex Gladstein of the Human Rights Foundation (HRF) calls it the "organizational brain": an AI that staff meeting transcripts, weekly updates and the organisation's own output are fed into, so anyone in the organisation can ask it what is going on ([1]). He credits Block with the idea. Jack Dorsey and Roelof Botha describe Block's version as a "company world model" built from the records that remote work leaves: "Decisions, discussions, code, designs, plans, problems, and progress" ([2]). They also write that Block "is in the early stages of this transition". Gladstein's team at HRF built one in a few weeks: years of public reports, an interview with each member, weekly meeting transcripts and Friday briefs, held in "an encrypted database that uses nostr" for permissions ([3]).

For Forge the useful part is narrower: an organisation keeps what its members should know, and a member asks by voice and hears the answer in the organisation's own words.

## The approaches

"Private" and "Standard" are the app's own terms ([PRIVACY.md](PRIVACY.md)). A Private model runs in sealed hardware and the question is encrypted to it. The gateway and the supplier of a Standard model can read the question. Every sealed claim rests on the word of the hardware makers: Tinfoil's checks end at the processor maker's root certificate (AMD or Intel) and NVIDIA's own check of the GPU ([16]). A sealed Bellows also rests on whoever approves the builds clients trust ([17]).

| Approach | Where the knowledge sits | Who can read it | Cost | Update and revoke | Phone on a weak connection |
| - | - | - | - | - | - |
| Retrieval on a server, RAG ([4]) | The organisation's server or cloud host | Its admins and host: everything. The engine's operator: the passages sent with each question, unless they go encrypted to a Private model. A Standard model's supplier: those passages. The network: metadata | A server; little per question | Instant on the server; revoke by removing access | Every question needs a connection |
| Retrieval on the phone ([5], [6]) | A signed package on each member's phone | Whoever holds the phone, or takes it unlocked: the whole package. Nobody else until a question goes to a model, then as above. The network: that a package was fetched, and its size | Nothing per search; phone storage | A new version when online; an offline phone keeps the old one until it expires | Search and reading aloud work offline |
| Long context or a cached corpus ([7], [8]) | Sent whole with every question | The engine's operator: everything, every time, unless encrypted to a Private model. The supplier: everything, and its cache keeps it for minutes | The whole corpus is paid for on every question; cached reads cost less | Stop sending it | Large uploads every time |
| Fine-tuned or adapter model ([9]) | Inside the model's weights | Whoever trains it reads it all. Whoever holds the weights can draw text back out ([10]) | A training run per change | Retrain; copies cannot be recalled | No source passage; only small models fit a phone |
| Knowledge graph or memory store ([11], [3]) | A database on a server, built by a model that reads every document | The indexing model: everything. Admins and host. Members: what their access rules allow | High: a model reads the whole corpus | Continuous; revoke through access rules | The phone is a client and needs a connection |
| Live tool access over MCP ([12], [13]) | In the organisation's tools: drives, chat, email | Those services' operators, the agent's host, and the model for each question. MCP "cannot enforce these security principles at the protocol level" | The tools' own costs | Remove a connector or token | Needs a connection |
| Sealed retrieval ([16], [17]) | An index inside sealed hardware, such as a Bellows-style engine | Contents: only the sealed machine. The operator: timing, volume and client addresses | Sealed hosting | Instant | Needs a connection. Bellows has no retrieval today |

## What fits Forge

The `guides` kind should support two things first.

**Retrieval on the phone, over a signed guide package.** It is the only approach that works with no connection, and the only one where the engine's operator and every supplier see nothing until the person asks a model. The answer can be the organisation's own passage, read aloud by the phone's voice, with no model at all. That suits people who read poorly and people on a bad connection, and the source is always on screen.

**A model answer from those passages, from a Private model only.** The phone picks the best few passages and sends them with the question, encrypted to the sealed machine. The engine's operator relays ciphertext. The answer is shown after the passages it used, so a person can hear the source and compare.

The organisation keeps its full brain wherever it chooses: an encrypted database like HRF's, a shared folder, a sealed server. A guide package is the vetted part it publishes to members' phones. This split is what limits a seizure. Serbian police unlocked journalists' and activists' phones with Cellebrite tools while they were held ([14]). Searches of Belarusian rights groups in July 2021 took "laptops, mobile phones and computers" ([18]). A seized phone should give up one role's guides and nothing about who else holds them. Central stores fail too. An attack on the ICRC exposed data on more than 515,000 people ([19]), and a 2017 US warrant asked a web host for "1.3 million visitor IP addresses" of a protest site ([20]).

Rejected for now:

- **Server retrieval and knowledge graphs.** The host and the admins read everything, one seizure or legal demand takes the whole brain, and nothing works offline. They remain good homes for the organisation's own brain.
- **Long context.** The whole corpus travels with every question, which costs the most and exposes the most, and models use the middle of a long input poorly ([7]).
- **Fine-tuning.** There is no source passage to show, no way to take knowledge back, and weights can leak their training text.
- **MCP to hosted tools.** The tools' operators read everything, and every question needs a connection. MCP suits an organisation's own agent reaching its brain. The phone app has no use for it yet.
- **Sealed retrieval** comes later, for a large, live brain queried over the network, once a sealed engine can search.

## The shape of a guides module

This section is a proposal. Today the registry hands `guides` only `t` and `ui` (`INPUTS` in [`public/v2/core/registry.js`](../public/v2/core/registry.js)), and no screen uses the kind ([modules/README.md](modules/README.md)).

| Input | What it is | Today |
| - | - | - |
| `t`, `ui` | The string table and the app's drawing helpers | Handed to `guides` |
| `scan` | The camera, for single and animated QR codes | Handed to `fund` only |
| `verify` | Schnorr signature check and SHA-256, from the vendored noble library the app already uses for eCash (`schnorrVerify` in `public/v2/core/cashu.js`) | New |
| `store` | Storage on the phone for this module only, cleared by Burn all and Erase everything | New |

A guides module gets no engine, wallet or network. The app fetches a package for it once the person agrees, and the app asks the model.

| It provides | What it does |
| - | - |
| `id` | A short name, as for every kind |
| `list()` | The guides on the phone: title, publisher, version, expiry, size |
| `preview(code)` | Opens a guide code, checks the hash and signature, and returns what the person must see before adding. Keeps nothing |
| `add(preview)` | Keeps the package after the person confirms, and builds its search index on the phone |
| `search(question, {limit})` | Passages: `{text, guide, section, publisher, version}` |
| `remove(id)` | Burns one guide and its key |
| `forget()` | Burns every guide; called by Burn all and Erase everything |

**The package.** One file: gzip-compressed JSON, encrypted with a random content key using the browser's built-in AES-GCM.

```json
{
  "id": "org.example.field",
  "version": 3,
  "title": { "en": "Staying safe at protests" },
  "lang": "en",
  "shelf": "field",
  "publisher": "npub1...",
  "expires": "2027-03-01",
  "passages": [
    { "id": "p12", "section": "Arrest / Your phone", "text": "..." }
  ]
}
```

**Signing.** The publisher signs a Nostr event (NIP-01, Schnorr over secp256k1, [15]) naming the file's SHA-256, its id, version and expiry. The module checks the hash and the signature before the preview shows. The event kind is open.

**Adding.** A guide code is a QR code or link that carries where to fetch the file, its hash and its content key. The key sits in the link's fragment, the way an event pass keeps its code out of server logs ([API.md](API.md#event-passes)). The file's host learns only that an encrypted file of that size was fetched. A small package can go from phone to phone as an animated QR code, with no network. The preview shows the publisher's name as the person saved it, a short key fingerprint, the size and the expiry.

**Revoking and burning.** A package stops answering at its expiry. A publisher can publish a signed "withdrawn" or "replaced" event, which the app checks when online. A person can burn one guide or all of them. A withdrawn guide stays on a phone that never comes online, until it expires, and copies cannot be recalled.

**The answer screen.** The matching passage comes first and is read aloud first. Under it: the guide's title and section, the publisher with its fingerprint and a mark that the signature checked, and the version and date. A model's answer, when asked for, is labelled as the model's and comes after the passages. When search finds nothing, the screen says so and does not guess.

## What to build at the event

1. **Ask your guides, offline.** One day, two people. A `guides` module with one bundled sample package, word search on the phone, the answer screen, and reading aloud through the existing voice-out modules. Useful on its own. Sample text: Security-in-a-Box, under CC BY-SA 4.0 with credit ([21]).
2. **Make and sign a package.** One day. A command-line tool that turns a folder of Markdown into passages, encrypts the file, signs it with a Nostr key and verifies it.
3. **Add a guide by QR.** One to two days. Guide codes with the key in the fragment, the preview screen, and the animated QR handoff.
4. **Answer with a Private model.** One day. Send the best passages with the question to a Private model only, and show the answer after them.
5. **Withdraw, expire, burn.** One day. Expiry, the withdrawn event, Burn one and Burn all.

## Risks and open questions

- **Signatures and the sandbox are not built.** The registry does not check `publisher` or `sig`, and a module runs as page code that can reach the page's storage and the network ([modules/README.md](modules/README.md#not-built)). Until slice B2, a guides module is trusted code in a release, and only the package signature in this design is checked, by the module itself.
- **The passphrase lock is not built** (A12). A guide on the phone is as safe as the phone's own lock, and [14] shows how far that goes.
- **Prompt injection.** Guide text reaches the model. Block's red team hid instructions in invisible characters and found that agents "can not effectively isolate untrusted context" ([13]). The tool and the app should strip invisible characters, guide questions get no tools, and the passage always shows beside the answer. A model can still be misled by a passage.
- **A compromised or coerced publisher** can sign anything. A signature proves only who signed. Two signers per release, keys per shelf, and a warning when a key changes are open.
- **Stale guides.** Expiry forces a refresh, but a person offline may lose a guide they need.
- **Limits of "private".** The sealed claims rest on the hardware makers and on whoever approves builds. The file's host sees who fetched it, when, and its size. Whoever holds the phone reads every guide on it.
- **Search.** Word search misses paraphrase and works poorly across languages. A search model on the phone costs a download.
- **The format.** Whether to reuse ZIM, which Kiwix uses for offline compressed content with a search index ([6]), is still open ([MODULES.md](MODULES.md#open-questions)). Recorded audio per passage, in a trusted local voice, is open too.

## Sources

Every link was opened on 2026-11-17.

1. [Alex Gladstein, "How AI Agents Are Empowering Human-Rights Defenders", Journal of Democracy, July 2026](https://www.journalofdemocracy.org/online-exclusive/how-ai-agents-are-empowering-human-rights-defenders/), also on [HRF's site](https://hrf.org/latest/how-ai-agents-are-empowering-human-rights-defenders/): the "organizational brain", credited to Block, fed by meetings, updates and channels.
2. [Jack Dorsey and Roelof Botha, "From Hierarchy to Intelligence", Block, 31 March 2026](https://block.xyz/inside/from-hierarchy-to-intelligence), also on [Sequoia's site](https://sequoiacap.com/article/from-hierarchy-to-intelligence): the company and customer world models, what feeds them, and "early stages".
3. [Alex Gladstein on X, 11 September 2026](https://x.com/gladstein/status/2098378170806182050): how HRF built its Freedom Tech brain. His [18 June 2026 post](https://x.com/gladstein/status/2067646581243850996) says organisations are "Following in the footsteps of Block".
4. [Lewis et al., Retrieval-Augmented Generation, 2020](https://arxiv.org/abs/2005.11401): retrieval over a document index.
5. [Kleppmann et al., Local-first software, Ink & Switch, 2019](https://www.inkandswitch.com/essay/local-first/): data kept on the person's own device, working offline.
6. [Kiwix](https://kiwix.org/en/) and [libzim](https://github.com/openzim/libzim): offline knowledge on phones in compressed ZIM files with optional search.
7. [Liu et al., Lost in the Middle, 2023](https://arxiv.org/abs/2307.03172): models use information in the middle of long inputs poorly.
8. [Anthropic, prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): cached prompts kept for minutes and read at a lower price.
9. [Hu et al., LoRA, 2021](https://arxiv.org/abs/2106.09685): adapter training on a frozen model.
10. [Carlini et al., Extracting Training Data from Large Language Models, 2020](https://arxiv.org/abs/2012.07805): training text drawn back out of a model.
11. [Edge et al., GraphRAG, 2024](https://arxiv.org/abs/2404.16130): a knowledge graph built by a model over a corpus.
12. [Model Context Protocol specification, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18): what MCP is and that it cannot enforce its security principles.
13. [Block, "How we red-teamed our own AI agent", January 2026](https://engineering.block.xyz/blog/how-we-red-teamed-our-own-ai-agent-): invisible instructions in calendar invites and shared recipes for Block's agent, goose, and the fixes. Block's [goose announcement, January 2025](https://block.xyz/inside/block-open-source-introduces-codename-goose) describes goose and its use of MCP.
14. [Amnesty Security Lab, "A Digital Prison", December 2024](https://securitylab.amnesty.org/latest/2024/12/serbia-a-digital-prison-spyware-and-cellebrite-used-on-journalists-and-activists/): phones unlocked with Cellebrite during detention, then spyware installed.
15. [Nostr NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md): signed events, Schnorr signatures over secp256k1.
16. [Tinfoil, attestation architecture](https://docs.tinfoil.sh/verification/attestation-architecture): the AMD, Intel and NVIDIA roots its sealed machines rest on.
17. [Bellows, what stays sealed, and the limits](https://bellows.forgereserve.org/docs/overview.html): what the operator still sees, and that builds are approved by the operator's keyserver.
18. [FIDH, Belarus searches, July 2021](https://www.fidh.org/en/issues/human-rights-defenders/belarus-ongoing-searches-and-arrests-of-human-rights-defenders-and): documents, laptops and phones taken from rights defenders.
19. [ICRC, "Cyber attack on ICRC: What we know"](https://www.icrc.org/en/document/cyber-attack-icrc-what-we-know): data on more than 515,000 people exposed.
20. [DreamHost, "We fight for the users", August 2017](https://www.dreamhost.com/news/announcements/we-fight-for-the-users/): a warrant for visitor records of a protest site.
21. [Security-in-a-Box, About](https://securityinabox.org/en/about/): Front Line Defenders' digital security guide and its CC BY-SA 4.0 licence.
