// The first run's hero art (C-Welcome, C-Pay, C-Limits, C-Private, approved 2026-11-14), lifted from the
// design files as they are, with these marks added for the screen (screens/firstrun.js):
// - class "fr-arc" on the lit ring arcs and "fr-tip" on their end dots, for the fill between steps;
// - on Private only, data-fr marks the parts that change with the setting (the shackle, the glow and the
//   keyhole), which are drawn here as On; and its full rings are turned to start at the top like the
//   others (a full circle looks the same).
// Each step's ids carry its own prefix (c1- to c4-), so they stay unique. The label (role img) comes
// from the string table. The markup is static and from this file only.

/** Each step's art: a 300 by 300 SVG. */
export const ART = {
  welcome: `
<svg width="300" height="300" viewBox="0 0 300 300" class="fr-art" role="img">
  <defs>
    <radialGradient id="c1-aura" cx="50%" cy="50%" r="50%"><stop offset="0.5" stop-color="#E2B552" stop-opacity="0.20"></stop><stop offset="0.78" stop-color="#E2B552" stop-opacity="0.05"></stop><stop offset="1" stop-color="#E2B552" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c1-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7DC95"></stop><stop offset="0.5" stop-color="#E2B552"></stop><stop offset="1" stop-color="#C08A2A"></stop></linearGradient>
    <linearGradient id="c1-teal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8EF3DE"></stop><stop offset="0.5" stop-color="#3FCFB4"></stop><stop offset="1" stop-color="#1F9E87"></stop></linearGradient>
    <radialGradient id="c1-disc" cx="50%" cy="50%" r="50%" fx="34%" fy="28%"><stop offset="0" stop-color="#1E242C"></stop><stop offset="0.55" stop-color="#13171C"></stop><stop offset="1" stop-color="#090B0E"></stop></radialGradient>
    <radialGradient id="c1-discglow" cx="78%" cy="82%" r="60%"><stop offset="0" stop-color="#3FCFB4" stop-opacity="0.20"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c1-discrim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.20"></stop><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.03"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0.40"></stop></linearGradient>
    <linearGradient id="c1-cloth" gradientUnits="userSpaceOnUse" x1="100" y1="80" x2="200" y2="230"><stop offset="0" stop-color="#5E6672"></stop><stop offset="0.32" stop-color="#3C424C"></stop><stop offset="0.62" stop-color="#262A31"></stop><stop offset="1" stop-color="#17191D"></stop></linearGradient>
    <linearGradient id="c1-lip" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#8A929E"></stop><stop offset="0.35" stop-color="#555C67"></stop><stop offset="0.72" stop-color="#2D3138"></stop><stop offset="1" stop-color="#1A1C21"></stop></linearGradient>
    <linearGradient id="c1-lining" x1="0" y1="0.1" x2="0.75" y2="0.9"><stop offset="0" stop-color="#343942"></stop><stop offset="0.25" stop-color="#191C21"></stop><stop offset="0.55" stop-color="#08090B"></stop><stop offset="1" stop-color="#000000"></stop></linearGradient>
    <radialGradient id="c1-chest" gradientUnits="userSpaceOnUse" cx="118" cy="212" r="70"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.08"></stop><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c1-turn" gradientUnits="userSpaceOnUse" x1="140" y1="0" x2="230" y2="0"><stop offset="0" stop-color="#000000" stop-opacity="0"></stop><stop offset="1" stop-color="#000000" stop-opacity="0.45"></stop></linearGradient>
    <linearGradient id="c1-ridge" gradientUnits="userSpaceOnUse" x1="123" y1="152" x2="177" y2="102"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0"></stop><stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0.55"></stop><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.08"></stop></linearGradient>
    <radialGradient id="c1-void" cx="50%" cy="42%" r="62%"><stop offset="0" stop-color="#000000"></stop><stop offset="0.7" stop-color="#020304"></stop><stop offset="1" stop-color="#0A0C10"></stop></radialGradient>
    <linearGradient id="c1-cord" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E4E7EB"></stop><stop offset="1" stop-color="#8C939E"></stop></linearGradient>
    <linearGradient id="c1-metal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#F2F4F7"></stop><stop offset="0.5" stop-color="#B9C0C9"></stop><stop offset="1" stop-color="#6E7682"></stop></linearGradient>
    <linearGradient id="c1-vign" x1="0" y1="0" x2="0" y2="1"><stop offset="0.6" stop-color="#090B0E" stop-opacity="0"></stop><stop offset="1" stop-color="#090B0E" stop-opacity="0.85"></stop></linearGradient>
    <clipPath id="c1-clip"><circle cx="150" cy="150" r="81"></circle></clipPath>
    <filter id="c1-b1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1"></feGaussianBlur></filter>
    <filter id="c1-b2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"></feGaussianBlur></filter>
    <filter id="c1-b4" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"></feGaussianBlur></filter>
    <filter id="c1-b8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"></feGaussianBlur></filter>
    <filter id="c1-b05" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.6"></feGaussianBlur></filter>
    <filter id="c1-grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.95 0.7" numOctaves="2" seed="7" stitchTiles="stitch" result="n"></feTurbulence><feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.4 0 0 0 -0.62" result="lt"></feColorMatrix><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.4 0 0 0 0.78" result="dk"></feColorMatrix><feMerge result="m"><feMergeNode in="lt"></feMergeNode><feMergeNode in="dk"></feMergeNode></feMerge><feComposite in="m" in2="SourceAlpha" operator="in"></feComposite></filter>
  </defs>

  <circle cx="150" cy="150" r="150" fill="url(#c1-aura)"></circle>
  <circle cx="150" cy="150" r="118" fill="none" stroke="#E2B552" stroke-opacity="0.14" stroke-width="10"></circle>
  <circle cx="150" cy="150" r="94" fill="none" stroke="#3FCFB4" stroke-opacity="0.13" stroke-width="10"></circle>
  <g transform="rotate(-90 150 150)" fill="none" stroke-linecap="round">
    <circle class="fr-arc" cx="150" cy="150" r="118" stroke="#E2B552" stroke-width="14" stroke-dasharray="185.4 741.4" opacity="0.35" filter="url(#c1-b4)"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="118" stroke="url(#c1-gold)" stroke-width="10" stroke-dasharray="185.4 741.4"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="94" stroke="#3FCFB4" stroke-width="14" stroke-dasharray="147.7 590.6" opacity="0.35" filter="url(#c1-b4)"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="94" stroke="url(#c1-teal)" stroke-width="10" stroke-dasharray="147.7 590.6"></circle>
  </g>
  <circle class="fr-tip" cx="268" cy="150" r="7" fill="#E2B552" opacity="0.6" filter="url(#c1-b2)"></circle>
  <circle class="fr-tip" cx="268" cy="150" r="2.6" fill="#FFF6DC"></circle>
  <circle class="fr-tip" cx="244" cy="150" r="7" fill="#3FCFB4" opacity="0.6" filter="url(#c1-b2)"></circle>
  <circle class="fr-tip" cx="244" cy="150" r="2.6" fill="#E6FFF9"></circle>

  <circle cx="150" cy="150" r="82" fill="url(#c1-disc)"></circle>
  <circle cx="150" cy="150" r="82" fill="url(#c1-discglow)"></circle>

  <g clip-path="url(#c1-clip)">
    <ellipse cx="138" cy="118" rx="58" ry="46" fill="#E2B552" opacity="0.07" filter="url(#c1-b8)"></ellipse>
    <path d="M46 258C52 234 66 216 90 201L202 197C216 201 230 209 240 222C246 232 250 244 252 258Z" fill="url(#c1-cloth)"></path>
    <path d="M46 258C52 234 66 216 90 201L202 197C216 201 230 209 240 222C246 232 250 244 252 258Z" fill="url(#c1-chest)"></path>
    <path d="M46 258C52 234 66 216 90 201L202 197C216 201 230 209 240 222C246 232 250 244 252 258Z" fill="url(#c1-turn)"></path>
    <path d="M60 244C66 222 80 208 98 201C88 212 80 226 76 246Z" fill="#FFFFFF" opacity="0.10" filter="url(#c1-b2)"></path>
    <g fill="none" stroke-linecap="round">
      <path d="M147 200C133 206 118 212 104 223" stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="2" filter="url(#c1-b1)"></path>
      <path d="M150 203C136 209 121 215 107 227" stroke="#000000" stroke-opacity="0.4" stroke-width="4" filter="url(#c1-b2)"></path>
      <path d="M114 207C118 215 120 224 120 236" stroke="#FFFFFF" stroke-opacity="0.06" stroke-width="2" filter="url(#c1-b1)"></path>
      <path d="M118 206C122 214 124 223 124 236" stroke="#000000" stroke-opacity="0.35" stroke-width="4" filter="url(#c1-b2)"></path>
      <path d="M170 199.5C182 204.5 193 210 203 218" stroke="#FFFFFF" stroke-opacity="0.04" stroke-width="2" filter="url(#c1-b1)"></path>
      <path d="M168 202C180 207 191 213 201 221" stroke="#000000" stroke-opacity="0.45" stroke-width="4" filter="url(#c1-b2)"></path>
      <path d="M143 199C150 203 164 203 173 199" stroke="#FFFFFF" stroke-opacity="0.06" stroke-width="1.5" filter="url(#c1-b05)"></path>
      <path d="M144 201C151 205 163 205 172 201" stroke="#000000" stroke-opacity="0.35" stroke-width="3" filter="url(#c1-b1)"></path>
    </g>
    <path d="M90 201C112 204 140 201 159 197C172 199 188 200 202 197" fill="none" stroke="#000000" stroke-opacity="0.55" stroke-width="6" transform="translate(1 3)" filter="url(#c1-b2)"></path>

    <path d="M90 201C97 186 99 168 99 150C99 124 106 103 121 92C131 85 141 80 150 79C173 79 191 98 197 122C201 140 200 162 196 178C194 186 197 192 202 197C188 200 172 199 159 197C140 201 112 204 90 201Z" fill="url(#c1-cloth)"></path>
    <path d="M101 150C101 120 112 96 134 86C141 83 146 82 150 81C132 90 117 106 110 130C108 140 107 150 106 160Z" fill="#FFFFFF" opacity="0.17" filter="url(#c1-b2)"></path>
    <path d="M147 93C143 88 141 84 140 81C148 79 156 79 164 81C165 86 167 90 168 94C161 92 153 92 147 93Z" fill="#FFFFFF" opacity="0.05"></path>
    <g fill="none" stroke-linecap="round">
      <path d="M104 118C102 138 102 160 105 186" stroke="#FFFFFF" stroke-opacity="0.09" stroke-width="4" filter="url(#c1-b2)"></path>
      <path d="M111 116C109 140 109 164 113 192" stroke="#000000" stroke-opacity="0.35" stroke-width="3.5" filter="url(#c1-b2)"></path>
      <path d="M138 199C126 193 113 186 104 175" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="1.6" filter="url(#c1-b05)"></path>
      <path d="M141 197C129 191 117 183 108 171" stroke="#000000" stroke-opacity="0.35" stroke-width="3" filter="url(#c1-b1)"></path>
      <path d="M128 200C117 197 107 191 100 183" stroke="#000000" stroke-opacity="0.3" stroke-width="2.5" filter="url(#c1-b1)"></path>
      <path d="M176 197C186 193 193 187 197 179" stroke="#000000" stroke-opacity="0.35" stroke-width="2.5" filter="url(#c1-b1)"></path>
      <path d="M145 93.5C142 89 140 85 139 82" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="0.7" transform="translate(-1 0.3)"></path>
      <path d="M145 93.5C142 89 140 85 139 82" stroke="#000000" stroke-opacity="0.45" stroke-width="1.3" filter="url(#c1-b05)"></path>
      <path d="M169 94.5C167 90 165.5 86 164.5 81.5" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="0.7" transform="translate(-1 0.3)"></path>
      <path d="M169 94.5C167 90 165.5 86 164.5 81.5" stroke="#000000" stroke-opacity="0.45" stroke-width="1.3" filter="url(#c1-b05)"></path>
    </g>
    <g opacity="0.2" filter="url(#c1-grain)">
      <path d="M46 258C52 234 66 216 90 201L202 197C216 201 230 209 240 222C246 232 250 244 252 258Z" fill="#FFFFFF"></path>
      <path d="M90 201C97 186 99 168 99 150C99 124 106 103 121 92C131 85 141 80 150 79C173 79 191 98 197 122C201 140 200 162 196 178C194 186 197 192 202 197C188 200 172 199 159 197C140 201 112 204 90 201Z" fill="#FFFFFF"></path>
    </g>
    <path d="M90 201C112 204 140 201 159 197C172 199 188 200 202 197" fill="none" stroke="#000000" stroke-opacity="0.35" stroke-width="3" filter="url(#c1-b1)"></path>

    <path d="M157 92C179 92 193 113 192 140C191 165 177 185 159 193C139 188 120 168 119 141C118 113 135 92 157 92Z" fill="none" stroke="#000000" stroke-opacity="0.5" stroke-width="5" transform="translate(1.5 2)" filter="url(#c1-b2)"></path>
    <path d="M157 92C179 92 193 113 192 140C191 165 177 185 159 193C139 188 120 168 119 141C118 113 135 92 157 92ZM158 100C175 100 186 118 185 141C184 162 173 178 159 185C143 181 128 164 127 141C126 118 140 100 158 100Z" fill="url(#c1-lip)" fill-rule="evenodd"></path>
    <path d="M157 92C179 92 193 113 192 140C191 165 177 185 159 193C139 188 120 168 119 141C118 113 135 92 157 92ZM158 100C175 100 186 118 185 141C184 162 173 178 159 185C143 181 128 164 127 141C126 118 140 100 158 100Z" fill="#FFFFFF" fill-rule="evenodd" opacity="0.16" filter="url(#c1-grain)"></path>
    <g fill="none" stroke-linecap="round">
      <path d="M123 152C122 120 137 96 158 96C166 96 172 98 177 102" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="4" filter="url(#c1-b1)"></path>
      <path d="M123 152C122 120 137 96 158 96C166 96 172 98 177 102" stroke="url(#c1-ridge)" stroke-width="1.4"></path>
      <path d="M188 140C187 163 175 181 159 189" stroke="#000000" stroke-opacity="0.25" stroke-width="4" filter="url(#c1-b1)"></path>
      <path d="M143.1 176.8L139.6 182.2" stroke="#000000" stroke-opacity="0.35" stroke-width="1.2" filter="url(#c1-b05)"></path>
      <path d="M172.6 175L175.8 180" stroke="#000000" stroke-opacity="0.35" stroke-width="1.2" filter="url(#c1-b05)"></path>
      <path d="M159 186L159 192" stroke="#000000" stroke-opacity="0.45" stroke-width="1.6" filter="url(#c1-b05)"></path>
      <path d="M191.5 140C190.5 164 177 184 160 192.5" stroke="#3FCFB4" stroke-opacity="0.3" stroke-width="3" filter="url(#c1-b1)"></path>
      <path d="M191.5 140C190.5 164 177 184 160 192.5" stroke="#3FCFB4" stroke-opacity="0.6" stroke-width="1.3"></path>
    </g>

    <path d="M158 100C175 100 186 118 185 141C184 162 173 178 159 185C143 181 128 164 127 141C126 118 140 100 158 100Z" fill="url(#c1-lining)"></path>
    <path d="M161 106C175 106 183 122 182 142C181 160 172 174 160 179C148 176 137 162 136 142C135 122 146 106 161 106Z" fill="#000000" filter="url(#c1-b2)"></path>
    <path d="M161 112C172 112 178 126 177 142C176 157 169 168 160 172C151 169 143 158 142 142C141 126 150 112 161 112Z" fill="url(#c1-void)"></path>
    <path d="M158 100C175 100 186 118 185 141C184 162 173 178 159 185C143 181 128 164 127 141C126 118 140 100 158 100Z" fill="none" stroke="#000000" stroke-opacity="0.6" stroke-width="2" filter="url(#c1-b05)"></path>
    <path d="M184.6 130C186 150 178 170 162 183.5" fill="none" stroke="#3FCFB4" stroke-opacity="0.35" stroke-width="1.1" stroke-linecap="round" filter="url(#c1-b05)"></path>
    <path d="M128 136C129 117 141 101 157 100.6" fill="none" stroke="#FFFFFF" stroke-opacity="0.1" stroke-width="1" stroke-linecap="round" filter="url(#c1-b05)"></path>

    <path d="M197 122C201 140 200 162 196 178C194 186 197 192 202 197C216 201 230 209 240 222" fill="none" stroke="#3FCFB4" stroke-opacity="0.35" stroke-width="4" filter="url(#c1-b2)"></path>
    <path d="M197 122C201 140 200 162 196 178C194 186 197 192 202 197C216 201 230 209 240 222" fill="none" stroke="#3FCFB4" stroke-opacity="0.75" stroke-width="1.3"></path>
    <path d="M99 156C99 124 106 103 121 92C131 85 141 80 150 79" fill="none" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="1.3" stroke-linecap="round"></path>

    <g fill="none" stroke-linecap="round">
      <path d="M148.5 185.5C148 195 146.5 205 145.5 214" stroke="#000000" stroke-opacity="0.5" stroke-width="3" transform="translate(1.8 1.4)" filter="url(#c1-b1)"></path>
      <path d="M168.1 184C168.6 194 169.2 203 168.4 211" stroke="#000000" stroke-opacity="0.5" stroke-width="3" transform="translate(1.8 1.4)" filter="url(#c1-b1)"></path>
      <path d="M148.5 185.5C148 195 146.5 205 145.5 214" stroke="url(#c1-cord)" stroke-width="2.6"></path>
      <path d="M168.1 184C168.6 194 169.2 203 168.4 211" stroke="url(#c1-cord)" stroke-width="2.4"></path>
      <path d="M148.5 185.5C148 195 146.5 205 145.5 214" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="0.8" transform="translate(-0.7 0)"></path>
      <path d="M148.5 185.5C148 195 146.5 205 145.5 214" stroke="#000000" stroke-opacity="0.3" stroke-width="0.8" transform="translate(0.8 0)"></path>
      <path d="M168.1 184C168.6 194 169.2 203 168.4 211" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="0.7" transform="translate(-0.7 0)"></path>
      <path d="M168.1 184C168.6 194 169.2 203 168.4 211" stroke="#000000" stroke-opacity="0.35" stroke-width="0.8" transform="translate(0.7 0)"></path>
    </g>
    <ellipse cx="148.5" cy="184.6" rx="2.3" ry="1.8" fill="#050607" stroke="url(#c1-metal)" stroke-width="1.1"></ellipse>
    <ellipse cx="168.1" cy="183.3" rx="2.1" ry="1.7" fill="#050607" stroke="url(#c1-metal)" stroke-width="1"></ellipse>
    <g transform="rotate(6 145.5 217)">
      <rect x="143.7" y="213" width="3.6" height="9" rx="1.8" fill="url(#c1-metal)"></rect>
      <rect x="144.4" y="214.2" width="0.9" height="6.4" rx="0.45" fill="#FFFFFF" opacity="0.7"></rect>
    </g>
    <g transform="rotate(-3 168.3 214)">
      <rect x="166.6" y="210" width="3.4" height="8.5" rx="1.7" fill="url(#c1-metal)"></rect>
      <rect x="167.3" y="211.2" width="0.8" height="6" rx="0.4" fill="#FFFFFF" opacity="0.6"></rect>
    </g>
    <rect x="60" y="60" width="180" height="180" fill="url(#c1-vign)"></rect>
  </g>
  <circle cx="150" cy="150" r="81.5" fill="none" stroke="url(#c1-discrim)" stroke-width="1"></circle>
</svg>`,
  pay: `
<svg width="300" height="300" viewBox="0 0 300 300" class="fr-art" role="img">
  <defs>
    <radialGradient id="c2-aura" cx="50%" cy="50%" r="50%"><stop offset="0.5" stop-color="#E2B552" stop-opacity="0.22"></stop><stop offset="0.78" stop-color="#E2B552" stop-opacity="0.06"></stop><stop offset="1" stop-color="#E2B552" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c2-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7DC95"></stop><stop offset="0.5" stop-color="#E2B552"></stop><stop offset="1" stop-color="#C08A2A"></stop></linearGradient>
    <linearGradient id="c2-teal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8EF3DE"></stop><stop offset="0.5" stop-color="#3FCFB4"></stop><stop offset="1" stop-color="#1F9E87"></stop></linearGradient>
    <radialGradient id="c2-disc" cx="50%" cy="50%" r="50%" fx="34%" fy="28%"><stop offset="0" stop-color="#1E242C"></stop><stop offset="0.55" stop-color="#13171C"></stop><stop offset="1" stop-color="#090B0E"></stop></radialGradient>
    <radialGradient id="c2-discglow" cx="78%" cy="82%" r="60%"><stop offset="0" stop-color="#3FCFB4" stop-opacity="0.20"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c2-discrim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.20"></stop><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.03"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0.40"></stop></linearGradient>
    <linearGradient id="c2-edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7A5512"></stop><stop offset="0.07" stop-color="#B8862C"></stop><stop offset="0.19" stop-color="#F6D98E"></stop><stop offset="0.28" stop-color="#DDAA48"></stop><stop offset="0.55" stop-color="#A87A22"></stop><stop offset="0.82" stop-color="#6B4A10"></stop><stop offset="0.93" stop-color="#8F6A1E"></stop><stop offset="1" stop-color="#5E410D"></stop></linearGradient>
    <linearGradient id="c2-face" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#FFF0BE"></stop><stop offset="0.3" stop-color="#F2CF78"></stop><stop offset="0.62" stop-color="#DDAE4E"></stop><stop offset="1" stop-color="#B3802A"></stop></linearGradient>
    <linearGradient id="c2-field" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#E9C36A"></stop><stop offset="0.5" stop-color="#D3A043"></stop><stop offset="1" stop-color="#A97A24"></stop></linearGradient>
    <linearGradient id="c2-wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5A3C08" stop-opacity="0.85"></stop><stop offset="0.5" stop-color="#9C7020" stop-opacity="0.4"></stop><stop offset="1" stop-color="#FFF2C8" stop-opacity="0.95"></stop></linearGradient>
    <linearGradient id="c2-emb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF4CF"></stop><stop offset="0.55" stop-color="#EAC46C"></stop><stop offset="1" stop-color="#C49035"></stop></linearGradient>
    <clipPath id="c2-clip"><circle cx="150" cy="150" r="81"></circle></clipPath>
    <clipPath id="c2-cface"><ellipse cx="152" cy="150" rx="44" ry="13"></ellipse></clipPath>
    <filter id="c2-b05" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.6"></feGaussianBlur></filter>
    <filter id="c2-b1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1"></feGaussianBlur></filter>
    <filter id="c2-b2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"></feGaussianBlur></filter>
    <filter id="c2-b4" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"></feGaussianBlur></filter>
    <filter id="c2-b8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"></feGaussianBlur></filter>
  </defs>

  <circle cx="150" cy="150" r="150" fill="url(#c2-aura)"></circle>
  <circle cx="150" cy="150" r="118" fill="none" stroke="#E2B552" stroke-opacity="0.14" stroke-width="10"></circle>
  <circle cx="150" cy="150" r="94" fill="none" stroke="#3FCFB4" stroke-opacity="0.13" stroke-width="10"></circle>
  <g transform="rotate(-90 150 150)" fill="none" stroke-linecap="round">
    <circle class="fr-arc" cx="150" cy="150" r="118" stroke="#E2B552" stroke-width="14" stroke-dasharray="370.7 741.4" opacity="0.35" filter="url(#c2-b4)"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="118" stroke="url(#c2-gold)" stroke-width="10" stroke-dasharray="370.7 741.4"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="94" stroke="#3FCFB4" stroke-width="14" stroke-dasharray="295.3 590.6" opacity="0.35" filter="url(#c2-b4)"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="94" stroke="url(#c2-teal)" stroke-width="10" stroke-dasharray="295.3 590.6"></circle>
  </g>
  <circle class="fr-tip" cx="150" cy="268" r="7" fill="#E2B552" opacity="0.6" filter="url(#c2-b2)"></circle>
  <circle class="fr-tip" cx="150" cy="268" r="2.6" fill="#FFF6DC"></circle>
  <circle class="fr-tip" cx="150" cy="244" r="7" fill="#3FCFB4" opacity="0.6" filter="url(#c2-b2)"></circle>
  <circle class="fr-tip" cx="150" cy="244" r="2.6" fill="#E6FFF9"></circle>

  <circle cx="150" cy="150" r="82" fill="url(#c2-disc)"></circle>
  <circle cx="150" cy="150" r="82" fill="url(#c2-discglow)"></circle>

  <g clip-path="url(#c2-clip)">
    <ellipse cx="148" cy="160" rx="56" ry="44" fill="#E2B552" opacity="0.10" filter="url(#c2-b8)"></ellipse>
    <ellipse cx="150" cy="204" rx="58" ry="10" fill="#E2B552" opacity="0.10" filter="url(#c2-b4)"></ellipse>
    <ellipse cx="150" cy="203" rx="54" ry="8" fill="#000000" opacity="0.7" filter="url(#c2-b4)"></ellipse>
    <ellipse cx="150" cy="202" rx="44" ry="4" fill="#000000" opacity="0.6" filter="url(#c2-b1)"></ellipse>

    <path d="M106 176V189A44 13 0 0 0 194 189V176A44 13 0 0 1 106 176Z" fill="url(#c2-edge)"></path>
    <path d="M194 177.3V188.5M193.8 178.2V189.4M193.4 179V190.2M192.9 179.9V191.1M192.1 180.7V191.9M191.2 181.5V192.7M190.1 182.3V193.5M188.8 183V194.2M187.4 183.8V195M185.8 184.5V195.7M184 185.1V196.3M182.1 185.8V197M180.1 186.4V197.6M177.9 186.9V198.1M175.6 187.5V198.7M173.2 187.9V199.1M170.7 188.4V199.6M168.2 188.7V199.9M165.5 189.1V200.3M162.8 189.3V200.5M160 189.6V200.8M157.2 189.7V200.9M154.3 189.8V201M151.4 189.9V201.1M148.6 189.9V201.1M145.7 189.8V201M142.8 189.7V200.9M140 189.6V200.8M137.2 189.3V200.5M134.5 189.1V200.3M131.8 188.7V199.9M129.3 188.4V199.6M126.8 187.9V199.1M124.4 187.5V198.7M122.1 186.9V198.1M119.9 186.4V197.6M117.9 185.8V197M116 185.1V196.3M114.2 184.5V195.7M112.6 183.8V195M111.2 183V194.2M109.9 182.3V193.5M108.8 181.5V192.7M107.9 180.7V191.9M107.1 179.9V191.1M106.6 179V190.2M106.2 178.2V189.4M106 177.3V188.5" fill="none" stroke="#462E05" stroke-opacity="0.42" stroke-width="0.8"></path>
    <path d="M193.6 178.6V189.8M193.2 179.4V190.6M192.5 180.3V191.5M191.7 181.1V192.3M190.7 181.9V193.1M189.5 182.6V193.8M188.1 183.4V194.6M186.6 184.1V195.3M184.9 184.8V196M183.1 185.5V196.7M181.1 186.1V197.3M179 186.7V197.9M176.8 187.2V198.4M174.4 187.7V198.9M172 188.2V199.4M169.5 188.6V199.8M166.8 188.9V200.1M164.1 189.2V200.4M161.4 189.5V200.7M158.6 189.7V200.9M155.7 189.8V201M152.9 189.9V201.1M150 189.9V201.1M147.1 189.9V201.1M144.3 189.8V201M141.4 189.7V200.9M138.6 189.5V200.7M135.9 189.2V200.4M133.2 188.9V200.1M130.5 188.6V199.8M128 188.2V199.4M125.6 187.7V198.9M123.2 187.2V198.4M121 186.7V197.9M118.9 186.1V197.3M116.9 185.5V196.7M115.1 184.8V196M113.4 184.1V195.3M111.9 183.4V194.6M110.5 182.6V193.8M109.3 181.9V193.1M108.3 181.1V192.3M107.5 180.3V191.5M106.8 179.4V190.6M106.4 178.6V189.8M106.1 177.8V189" fill="none" stroke="#FFEBB0" stroke-opacity="0.22" stroke-width="0.6"></path>
    <path d="M106 189A44 13 0 0 0 194 189" fill="none" stroke="#3C2804" stroke-opacity="0.6" stroke-width="0.8"></path>
    <path d="M194 177V188A44 13 0 0 1 178.3 199" fill="none" stroke="#3FCFB4" stroke-opacity="0.55" stroke-width="1.3" filter="url(#c2-b05)"></path>
    <ellipse cx="150" cy="176" rx="44" ry="13" fill="url(#c2-face)"></ellipse>
    <ellipse cx="146" cy="176" rx="45" ry="13.5" fill="#000000" opacity="0.5" filter="url(#c2-b2)"></ellipse>

    <path d="M102 163V176A44 13 0 0 0 190 176V163A44 13 0 0 1 102 163Z" fill="url(#c2-edge)"></path>
    <path d="M190 164.3V175.5M189.8 165.2V176.4M189.4 166V177.2M188.9 166.9V178.1M188.1 167.7V178.9M187.2 168.5V179.7M186.1 169.3V180.5M184.8 170V181.2M183.4 170.8V182M181.8 171.5V182.7M180 172.1V183.3M178.1 172.8V184M176.1 173.4V184.6M173.9 173.9V185.1M171.6 174.5V185.7M169.2 174.9V186.1M166.7 175.4V186.6M164.2 175.7V186.9M161.5 176.1V187.3M158.8 176.3V187.5M156 176.6V187.8M153.2 176.7V187.9M150.3 176.8V188M147.4 176.9V188.1M144.6 176.9V188.1M141.7 176.8V188M138.8 176.7V187.9M136 176.6V187.8M133.2 176.3V187.5M130.5 176.1V187.3M127.8 175.7V186.9M125.3 175.4V186.6M122.8 174.9V186.1M120.4 174.5V185.7M118.1 173.9V185.1M115.9 173.4V184.6M113.9 172.8V184M112 172.1V183.3M110.2 171.5V182.7M108.6 170.8V182M107.2 170V181.2M105.9 169.3V180.5M104.8 168.5V179.7M103.9 167.7V178.9M103.1 166.9V178.1M102.6 166V177.2M102.2 165.2V176.4M102 164.3V175.5" fill="none" stroke="#462E05" stroke-opacity="0.42" stroke-width="0.8"></path>
    <path d="M189.6 165.6V176.8M189.2 166.4V177.6M188.5 167.3V178.5M187.7 168.1V179.3M186.7 168.9V180.1M185.5 169.6V180.8M184.1 170.4V181.6M182.6 171.1V182.3M180.9 171.8V183M179.1 172.5V183.7M177.1 173.1V184.3M175 173.7V184.9M172.8 174.2V185.4M170.4 174.7V185.9M168 175.2V186.4M165.5 175.6V186.8M162.8 175.9V187.1M160.1 176.2V187.4M157.4 176.5V187.7M154.6 176.7V187.9M151.7 176.8V188M148.9 176.9V188.1M146 176.9V188.1M143.1 176.9V188.1M140.3 176.8V188M137.4 176.7V187.9M134.6 176.5V187.7M131.9 176.2V187.4M129.2 175.9V187.1M126.5 175.6V186.8M124 175.2V186.4M121.6 174.7V185.9M119.2 174.2V185.4M117 173.7V184.9M114.9 173.1V184.3M112.9 172.5V183.7M111.1 171.8V183M109.4 171.1V182.3M107.9 170.4V181.6M106.5 169.6V180.8M105.3 168.9V180.1M104.3 168.1V179.3M103.5 167.3V178.5M102.8 166.4V177.6M102.4 165.6V176.8M102.1 164.8V176" fill="none" stroke="#FFEBB0" stroke-opacity="0.22" stroke-width="0.6"></path>
    <path d="M102 176A44 13 0 0 0 190 176" fill="none" stroke="#3C2804" stroke-opacity="0.6" stroke-width="0.8"></path>
    <path d="M102 163A44 13 0 0 0 190 163" fill="none" stroke="#FFE7A8" stroke-opacity="0.6" stroke-width="0.9"></path>
    <path d="M190 164V175A44 13 0 0 1 174.3 186" fill="none" stroke="#3FCFB4" stroke-opacity="0.55" stroke-width="1.3" filter="url(#c2-b05)"></path>
    <ellipse cx="146" cy="163" rx="44" ry="13" fill="url(#c2-face)"></ellipse>
    <ellipse cx="152" cy="163" rx="45" ry="13.5" fill="#000000" opacity="0.5" filter="url(#c2-b2)"></ellipse>

    <path d="M108 150V163A44 13 0 0 0 196 163V150A44 13 0 0 1 108 150Z" fill="url(#c2-edge)"></path>
    <path d="M196 151.3V162.5M195.8 152.2V163.4M195.4 153V164.2M194.9 153.9V165.1M194.1 154.7V165.9M193.2 155.5V166.7M192.1 156.3V167.5M190.8 157V168.2M189.4 157.8V169M187.8 158.5V169.7M186 159.1V170.3M184.1 159.8V171M182.1 160.4V171.6M179.9 160.9V172.1M177.6 161.5V172.7M175.2 161.9V173.1M172.7 162.4V173.6M170.2 162.7V173.9M167.5 163.1V174.3M164.8 163.3V174.5M162 163.6V174.8M159.2 163.7V174.9M156.3 163.8V175M153.4 163.9V175.1M150.6 163.9V175.1M147.7 163.8V175M144.8 163.7V174.9M142 163.6V174.8M139.2 163.3V174.5M136.5 163.1V174.3M133.8 162.7V173.9M131.3 162.4V173.6M128.8 161.9V173.1M126.4 161.5V172.7M124.1 160.9V172.1M121.9 160.4V171.6M119.9 159.8V171M118 159.1V170.3M116.2 158.5V169.7M114.6 157.8V169M113.2 157V168.2M111.9 156.3V167.5M110.8 155.5V166.7M109.9 154.7V165.9M109.1 153.9V165.1M108.6 153V164.2M108.2 152.2V163.4M108 151.3V162.5" fill="none" stroke="#462E05" stroke-opacity="0.42" stroke-width="0.8"></path>
    <path d="M195.6 152.6V163.8M195.2 153.4V164.6M194.5 154.3V165.5M193.7 155.1V166.3M192.7 155.9V167.1M191.5 156.6V167.8M190.1 157.4V168.6M188.6 158.1V169.3M186.9 158.8V170M185.1 159.5V170.7M183.1 160.1V171.3M181 160.7V171.9M178.8 161.2V172.4M176.4 161.7V172.9M174 162.2V173.4M171.5 162.6V173.8M168.8 162.9V174.1M166.1 163.2V174.4M163.4 163.5V174.7M160.6 163.7V174.9M157.7 163.8V175M154.9 163.9V175.1M152 163.9V175.1M149.1 163.9V175.1M146.3 163.8V175M143.4 163.7V174.9M140.6 163.5V174.7M137.9 163.2V174.4M135.2 162.9V174.1M132.5 162.6V173.8M130 162.2V173.4M127.6 161.7V172.9M125.2 161.2V172.4M123 160.7V171.9M120.9 160.1V171.3M118.9 159.5V170.7M117.1 158.8V170M115.4 158.1V169.3M113.9 157.4V168.6M112.5 156.6V167.8M111.3 155.9V167.1M110.3 155.1V166.3M109.5 154.3V165.5M108.8 153.4V164.6M108.4 152.6V163.8M108.1 151.8V163" fill="none" stroke="#FFEBB0" stroke-opacity="0.22" stroke-width="0.6"></path>
    <path d="M108 163A44 13 0 0 0 196 163" fill="none" stroke="#3C2804" stroke-opacity="0.6" stroke-width="0.8"></path>
    <path d="M108 150A44 13 0 0 0 196 150" fill="none" stroke="#FFE7A8" stroke-opacity="0.7" stroke-width="0.9"></path>
    <path d="M196 151V162A44 13 0 0 1 180.3 173" fill="none" stroke="#3FCFB4" stroke-opacity="0.55" stroke-width="1.3" filter="url(#c2-b05)"></path>
    <g transform="translate(152 150) scale(1 0.2955)">
      <circle cx="0" cy="0" r="44" fill="url(#c2-face)"></circle>
      <circle cx="0" cy="0" r="37.5" fill="url(#c2-field)"></circle>
      <circle cx="0" cy="0" r="37.5" fill="none" stroke="url(#c2-wall)" stroke-width="2"></circle>
      <circle cx="0" cy="0" r="33.5" fill="none" stroke="#7A5614" stroke-opacity="0.55" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0.01 3.5"></circle>
    </g>
    <g clip-path="url(#c2-cface)">
      <ellipse cx="158" cy="153" rx="42" ry="8" fill="#000000" opacity="0.55" filter="url(#c2-b2)"></ellipse>
    </g>

    <g transform="translate(157 129) rotate(-10)">
      <ellipse cx="2" cy="20" rx="44" ry="15" fill="#000000" opacity="0.25" filter="url(#c2-b4)"></ellipse>
      <path d="M-44 0V11A44 17 0 0 0 44 11V0A44 17 0 0 1 -44 0Z" fill="url(#c2-edge)"></path>
      <path d="M44 1.5V10.7M43.8 2.6V11.8M43.4 3.7V12.9M42.9 4.8V14M42.1 5.8V15M41.2 6.9V16.1M40.1 7.9V17.1M38.8 8.9V18.1M37.4 9.9V19.1M35.8 10.8V20M34 11.7V20.9M32.1 12.5V21.7M30.1 13.3V22.5M27.9 14V23.2M25.6 14.7V23.9M23.2 15.3V24.5M20.7 15.9V25.1M18.2 16.4V25.6M15.5 16.8V26M12.8 17.2V26.4M10 17.5V26.7M7.2 17.7V26.9M4.3 17.8V27M1.4 17.9V27.1M-1.4 17.9V27.1M-4.3 17.8V27M-7.2 17.7V26.9M-10 17.5V26.7M-12.8 17.2V26.4M-15.5 16.8V26M-18.2 16.4V25.6M-20.7 15.9V25.1M-23.2 15.3V24.5M-25.6 14.7V23.9M-27.9 14V23.2M-30.1 13.3V22.5M-32.1 12.5V21.7M-34 11.7V20.9M-35.8 10.8V20M-37.4 9.9V19.1M-38.8 8.9V18.1M-40.1 7.9V17.1M-41.2 6.9V16.1M-42.1 5.8V15M-42.9 4.8V14M-43.4 3.7V12.9M-43.8 2.6V11.8M-44 1.5V10.7" fill="none" stroke="#462E05" stroke-opacity="0.42" stroke-width="0.8"></path>
      <path d="M43.6 3.1V12.3M43.2 4.2V13.4M42.5 5.3V14.5M41.7 6.4V15.6M40.7 7.4V16.6M39.5 8.4V17.6M38.1 9.4V18.6M36.6 10.3V19.5M34.9 11.2V20.4M33.1 12.1V21.3M31.1 12.9V22.1M29 13.7V22.9M26.8 14.4V23.6M24.4 15V24.2M22 15.6V24.8M19.5 16.1V25.3M16.8 16.6V25.8M14.1 17V26.2M11.4 17.3V26.5M8.6 17.6V26.8M5.7 17.8V27M2.9 17.9V27.1M0 17.9V27.1M-2.9 17.9V27.1M-5.7 17.8V27M-8.6 17.6V26.8M-11.4 17.3V26.5M-14.1 17V26.2M-16.8 16.6V25.8M-19.5 16.1V25.3M-22 15.6V24.8M-24.4 15V24.2M-26.8 14.4V23.6M-29 13.7V22.9M-31.1 12.9V22.1M-33.1 12.1V21.3M-34.9 11.2V20.4M-36.6 10.3V19.5M-38.1 9.4V18.6M-39.5 8.4V17.6M-40.7 7.4V16.6M-41.7 6.4V15.6M-42.5 5.3V14.5M-43.2 4.2V13.4M-43.6 3.1V12.3M-43.9 2V11.2" fill="none" stroke="#FFEBB0" stroke-opacity="0.22" stroke-width="0.6"></path>
      <path d="M-44 11A44 17 0 0 0 44 11" fill="none" stroke="#3C2804" stroke-opacity="0.6" stroke-width="0.8"></path>
      <path d="M-44 0A44 17 0 0 0 44 0" fill="none" stroke="#FFE7A8" stroke-opacity="0.75" stroke-width="0.9"></path>
      <path d="M44 1V10A44 17 0 0 1 28.3 24" fill="none" stroke="#3FCFB4" stroke-opacity="0.6" stroke-width="1.3" filter="url(#c2-b05)"></path>
      <g transform="scale(1 0.3864)">
        <circle cx="0" cy="0" r="44" fill="url(#c2-face)"></circle>
        <circle cx="0" cy="0" r="37.5" fill="url(#c2-field)"></circle>
        <circle cx="0" cy="0" r="37.5" fill="none" stroke="url(#c2-wall)" stroke-width="2"></circle>
        <circle cx="0" cy="0" r="33.5" fill="none" stroke="#7A5614" stroke-opacity="0.55" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0.01 3.5"></circle>
        <path d="M0 -17Q2.6 -2.6 17 0Q2.6 2.6 0 17Q-2.6 2.6 -17 0Q-2.6 -2.6 0 -17Z" fill="#5A3C08" opacity="0.55" transform="translate(1 1.6)"></path>
        <path d="M0 -17Q2.6 -2.6 17 0Q2.6 2.6 0 17Q-2.6 2.6 -17 0Q-2.6 -2.6 0 -17Z" fill="#FFF6D8" opacity="0.8" transform="translate(-0.7 -1.2)"></path>
        <path d="M0 -17Q2.6 -2.6 17 0Q2.6 2.6 0 17Q-2.6 2.6 -17 0Q-2.6 -2.6 0 -17Z" fill="url(#c2-emb)"></path>
        <circle cx="0" cy="0" r="22.5" fill="none" stroke="#FFF2C8" stroke-opacity="0.45" stroke-width="1"></circle>
        <circle cx="0" cy="0" r="22.5" fill="none" stroke="#6B4A10" stroke-opacity="0.35" stroke-width="1" transform="translate(0.6 1.4)"></circle>
        <circle cx="0" cy="0" r="44" fill="none" stroke="#FFF4D2" stroke-opacity="0.8" stroke-width="1.4" stroke-dasharray="70 300" stroke-dashoffset="-150"></circle>
        <ellipse cx="-17" cy="-20" rx="14" ry="7" fill="#FFFFFF" opacity="0.6" filter="url(#c2-b2)"></ellipse>
      </g>
    </g>
    <ellipse cx="128" cy="166" rx="3" ry="9" fill="#FFF6DC" opacity="0.45" filter="url(#c2-b1)"></ellipse>
    <ellipse cx="122" cy="179" rx="3" ry="8" fill="#FFF6DC" opacity="0.4" filter="url(#c2-b1)"></ellipse>
    <ellipse cx="124" cy="192" rx="3" ry="8" fill="#FFF6DC" opacity="0.35" filter="url(#c2-b1)"></ellipse>
  </g>
  <circle cx="150" cy="150" r="81.5" fill="none" stroke="url(#c2-discrim)" stroke-width="1"></circle>
</svg>`,
  limits: `
<svg width="300" height="300" viewBox="0 0 300 300" class="fr-art" role="img">
  <defs>
    <radialGradient id="c3-aura" cx="50%" cy="50%" r="50%"><stop offset="0.5" stop-color="#3FCFB4" stop-opacity="0.20"></stop><stop offset="0.78" stop-color="#3FCFB4" stop-opacity="0.05"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c3-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7DC95"></stop><stop offset="0.5" stop-color="#E2B552"></stop><stop offset="1" stop-color="#C08A2A"></stop></linearGradient>
    <linearGradient id="c3-teal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8EF3DE"></stop><stop offset="0.5" stop-color="#3FCFB4"></stop><stop offset="1" stop-color="#1F9E87"></stop></linearGradient>
    <radialGradient id="c3-disc" cx="50%" cy="50%" r="50%" fx="34%" fy="28%"><stop offset="0" stop-color="#1E242C"></stop><stop offset="0.55" stop-color="#13171C"></stop><stop offset="1" stop-color="#090B0E"></stop></radialGradient>
    <radialGradient id="c3-discglow" cx="78%" cy="82%" r="60%"><stop offset="0" stop-color="#3FCFB4" stop-opacity="0.20"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c3-discrim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.20"></stop><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.03"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0.40"></stop></linearGradient>
    <radialGradient id="c3-skin" cx="50%" cy="50%" r="50%" fx="36%" fy="28%"><stop offset="0" stop-color="#A9B0BA" stop-opacity="0.95"></stop><stop offset="0.42" stop-color="#737A85" stop-opacity="0.85"></stop><stop offset="0.75" stop-color="#353A42" stop-opacity="0.55"></stop><stop offset="1" stop-color="#13161A" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c3-crease" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#262A31" stop-opacity="0"></stop><stop offset="0.2" stop-color="#262A31" stop-opacity="0.9"></stop><stop offset="0.8" stop-color="#262A31" stop-opacity="0.9"></stop><stop offset="1" stop-color="#262A31" stop-opacity="0"></stop></linearGradient>
    <linearGradient id="c3-creasehi" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0"></stop><stop offset="0.25" stop-color="#FFFFFF" stop-opacity="0.32"></stop><stop offset="0.7" stop-color="#FFFFFF" stop-opacity="0.12"></stop><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"></stop></linearGradient>
    <linearGradient id="c3-lid" gradientUnits="userSpaceOnUse" x1="0" y1="112" x2="0" y2="176"><stop offset="0" stop-color="#F4F6F9"></stop><stop offset="0.35" stop-color="#D5DAE1"></stop><stop offset="0.7" stop-color="#9EA6B1"></stop><stop offset="1" stop-color="#646C78"></stop></linearGradient>
    <linearGradient id="c3-lidside" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0A0C10" stop-opacity="0.12"></stop><stop offset="0.3" stop-color="#0A0C10" stop-opacity="0"></stop><stop offset="0.6" stop-color="#0A0C10" stop-opacity="0"></stop><stop offset="1" stop-color="#0A0C10" stop-opacity="0.38"></stop></linearGradient>
    <linearGradient id="c3-lower" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7C8490"></stop><stop offset="1" stop-color="#454B55"></stop></linearGradient>
    <linearGradient id="c3-lash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2D323A"></stop><stop offset="1" stop-color="#101216"></stop></linearGradient>
    <linearGradient id="c3-vign" x1="0" y1="0" x2="0" y2="1"><stop offset="0.66" stop-color="#090B0E" stop-opacity="0"></stop><stop offset="1" stop-color="#090B0E" stop-opacity="0.75"></stop></linearGradient>
    <clipPath id="c3-clip"><circle cx="150" cy="150" r="81"></circle></clipPath>
    <filter id="c3-b05" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.6"></feGaussianBlur></filter>
    <filter id="c3-b1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"></feGaussianBlur></filter>
    <filter id="c3-b2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"></feGaussianBlur></filter>
    <filter id="c3-b4" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"></feGaussianBlur></filter>
    <filter id="c3-b6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"></feGaussianBlur></filter>
  </defs>

  <circle cx="150" cy="150" r="150" fill="url(#c3-aura)"></circle>
  <circle cx="150" cy="150" r="118" fill="none" stroke="#E2B552" stroke-opacity="0.14" stroke-width="10"></circle>
  <circle cx="150" cy="150" r="94" fill="none" stroke="#3FCFB4" stroke-opacity="0.13" stroke-width="10"></circle>
  <g transform="rotate(-90 150 150)" fill="none" stroke-linecap="round">
    <circle class="fr-arc" cx="150" cy="150" r="118" stroke="#E2B552" stroke-width="14" stroke-dasharray="556.1 741.4" opacity="0.35" filter="url(#c3-b4)"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="118" stroke="url(#c3-gold)" stroke-width="10" stroke-dasharray="556.1 741.4"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="94" stroke="#3FCFB4" stroke-width="14" stroke-dasharray="443 590.6" opacity="0.35" filter="url(#c3-b4)"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="94" stroke="url(#c3-teal)" stroke-width="10" stroke-dasharray="443 590.6"></circle>
  </g>
  <circle class="fr-tip" cx="32" cy="150" r="7" fill="#E2B552" opacity="0.6" filter="url(#c3-b2)"></circle>
  <circle class="fr-tip" cx="32" cy="150" r="2.6" fill="#FFF6DC"></circle>
  <circle class="fr-tip" cx="56" cy="150" r="7" fill="#3FCFB4" opacity="0.6" filter="url(#c3-b2)"></circle>
  <circle class="fr-tip" cx="56" cy="150" r="2.6" fill="#E6FFF9"></circle>

  <circle cx="150" cy="150" r="82" fill="url(#c3-disc)"></circle>
  <circle cx="150" cy="150" r="82" fill="url(#c3-discglow)"></circle>

  <g clip-path="url(#c3-clip)">
    <ellipse cx="150" cy="146" rx="80" ry="64" fill="url(#c3-skin)"></ellipse>
    <ellipse cx="130" cy="98" rx="36" ry="9" fill="#FFFFFF" opacity="0.16" transform="rotate(-8 130 98)" filter="url(#c3-b4)"></ellipse>
    <path d="M206 176C196 196 176 206 150 209" fill="none" stroke="#3FCFB4" stroke-opacity="0.4" stroke-width="2.4" stroke-linecap="round" filter="url(#c3-b2)"></path>

    <path d="M102 128C118 100 178 96 200 130" fill="none" stroke="url(#c3-creasehi)" stroke-width="1.4" stroke-linecap="round" transform="translate(0 -2.4)" filter="url(#c3-b05)"></path>
    <path d="M102 128C118 100 178 96 200 130" fill="none" stroke="url(#c3-crease)" stroke-width="2.6" stroke-linecap="round" filter="url(#c3-b05)"></path>
    <path d="M96 142C114 112 176 108 204 146" fill="none" stroke="#000000" stroke-opacity="0.45" stroke-width="4" filter="url(#c3-b1)"></path>

    <path d="M96 142C118 176 176 180 204 146C182 190 116 192 96 142Z" fill="url(#c3-lower)"></path>
    <path d="M100 150C122 182 178 186 200 154" fill="none" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="1"></path>

    <path d="M96 142C114 112 176 108 204 146C176 180 118 176 96 142Z" fill="url(#c3-lid)"></path>
    <path d="M96 142C114 112 176 108 204 146C176 180 118 176 96 142Z" fill="url(#c3-lidside)"></path>
    <ellipse cx="142" cy="134" rx="38" ry="13" fill="#FFFFFF" opacity="0.22" filter="url(#c3-b4)"></ellipse>
    <ellipse cx="134" cy="127" rx="22" ry="5.5" fill="#FFFFFF" opacity="0.8" transform="rotate(-12 134 127)" filter="url(#c3-b2)"></ellipse>
    <path d="M178 166C190 162 198 155 203 147" fill="none" stroke="#3FCFB4" stroke-opacity="0.65" stroke-width="1.4" stroke-linecap="round" filter="url(#c3-b05)"></path>
    <path d="M100 136C114 116 150 110 176 116" fill="none" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="1" stroke-linecap="round"></path>

    <path d="M96 142C118 176 176 180 204 146" fill="none" stroke="#1C2026" stroke-width="3.2" stroke-linecap="round"></path>
    <path d="M105 152.6Q100.5 154.7 96.7 156.4Q102.5 156.5 107.5 154.8ZM116.7 161Q112 165.7 107.7 169.3Q114.5 167 119.7 162.5ZM130.2 166.6Q126.9 173.6 123.3 179.1Q129.5 174.3 133.5 167.5ZM144.8 169.3Q143.9 177.5 142.1 184.2Q146.6 177.7 148.2 169.5ZM159.8 169.1Q163 177.5 169 183.9Q165.7 177.2 163.2 168.7ZM174.5 166Q180.7 173.3 189.1 178.2Q183.3 172.4 177.7 164.8ZM188.2 159.7Q195.7 163.9 204.6 165.6Q198 162.4 191 157.8Z" fill="#000000" opacity="0.35" transform="translate(0.8 1.6)" filter="url(#c3-b05)"></path>
    <path d="M105 152.6Q100.5 154.7 96.7 156.4Q102.5 156.5 107.5 154.8ZM116.7 161Q112 165.7 107.7 169.3Q114.5 167 119.7 162.5ZM130.2 166.6Q126.9 173.6 123.3 179.1Q129.5 174.3 133.5 167.5ZM144.8 169.3Q143.9 177.5 142.1 184.2Q146.6 177.7 148.2 169.5ZM159.8 169.1Q163 177.5 169 183.9Q165.7 177.2 163.2 168.7ZM174.5 166Q180.7 173.3 189.1 178.2Q183.3 172.4 177.7 164.8ZM188.2 159.7Q195.7 163.9 204.6 165.6Q198 162.4 191 157.8Z" fill="url(#c3-lash)"></path>

    <ellipse cx="156" cy="194" rx="46" ry="11" fill="#3FCFB4" opacity="0.18" filter="url(#c3-b6)"></ellipse>
    <rect x="60" y="60" width="180" height="180" fill="url(#c3-vign)"></rect>
  </g>
  <circle cx="150" cy="150" r="81.5" fill="none" stroke="url(#c3-discrim)" stroke-width="1"></circle>
</svg>`,
  private: `
<svg width="300" height="300" viewBox="0 0 300 300" class="fr-art" role="img">
  <defs>
    <radialGradient id="c4-aura" cx="50%" cy="50%" r="50%"><stop offset="0.5" stop-color="#3FCFB4" stop-opacity="0.24"></stop><stop offset="0.78" stop-color="#3FCFB4" stop-opacity="0.07"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c4-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7DC95"></stop><stop offset="0.5" stop-color="#E2B552"></stop><stop offset="1" stop-color="#C08A2A"></stop></linearGradient>
    <linearGradient id="c4-teal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8EF3DE"></stop><stop offset="0.5" stop-color="#3FCFB4"></stop><stop offset="1" stop-color="#1F9E87"></stop></linearGradient>
    <radialGradient id="c4-disc" cx="50%" cy="50%" r="50%" fx="34%" fy="28%"><stop offset="0" stop-color="#1E242C"></stop><stop offset="0.55" stop-color="#13171C"></stop><stop offset="1" stop-color="#090B0E"></stop></radialGradient>
    <radialGradient id="c4-discglow" cx="78%" cy="82%" r="60%"><stop offset="0" data-fr="glow-stop" stop-color="#3FCFB4" stop-opacity="0.22"></stop><stop offset="1" data-fr="glow-stop" stop-color="#3FCFB4" stop-opacity="0"></stop></radialGradient>
    <linearGradient id="c4-discrim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.20"></stop><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.03"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0.40"></stop></linearGradient>
    <linearGradient id="c4-shackle" gradientUnits="userSpaceOnUse" x1="104" y1="0" x2="196" y2="0"><stop offset="0.18" stop-color="#6A727E"></stop><stop offset="0.22" stop-color="#F1F4F8"></stop><stop offset="0.26" stop-color="#BAC1CB"></stop><stop offset="0.315" stop-color="#5E6672"></stop><stop offset="0.4" stop-color="#C9CFD7"></stop><stop offset="0.6" stop-color="#A9B0BA"></stop><stop offset="0.685" stop-color="#747C88"></stop><stop offset="0.72" stop-color="#E4E8ED"></stop><stop offset="0.76" stop-color="#AEB5BF"></stop><stop offset="0.815" stop-color="#59606B"></stop></linearGradient>
    <linearGradient id="c4-spec" gradientUnits="userSpaceOnUse" x1="0" y1="84" x2="0" y2="140"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"></stop><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"></stop></linearGradient>
    <linearGradient id="c4-edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E4E8EE"></stop><stop offset="0.5" stop-color="#8F97A3"></stop><stop offset="1" stop-color="#454C57"></stop></linearGradient>
    <linearGradient id="c4-face" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#F7F9FB"></stop><stop offset="0.35" stop-color="#D3D8DF"></stop><stop offset="0.75" stop-color="#A9B0BB"></stop><stop offset="1" stop-color="#8A929E"></stop></linearGradient>
    <linearGradient id="c4-facerim" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.95"></stop><stop offset="0.38" stop-color="#FFFFFF" stop-opacity="0.08"></stop><stop offset="1" stop-color="#3FCFB4" stop-opacity="0.6"></stop></linearGradient>
    <linearGradient id="c4-hole" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0A0C10"></stop><stop offset="1" stop-color="#2A2F37"></stop></linearGradient>
    <linearGradient id="c4-vign" x1="0" y1="0" x2="0" y2="1"><stop offset="0.7" stop-color="#090B0E" stop-opacity="0"></stop><stop offset="1" stop-color="#090B0E" stop-opacity="0.7"></stop></linearGradient>
    <clipPath id="c4-clip"><circle cx="150" cy="150" r="81"></circle></clipPath>
    <clipPath id="c4-faceclip"><rect x="113" y="141" width="74" height="64" rx="13"></rect></clipPath>
    <filter id="c4-b05" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.6"></feGaussianBlur></filter>
    <filter id="c4-b1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"></feGaussianBlur></filter>
    <filter id="c4-b2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"></feGaussianBlur></filter>
    <filter id="c4-b4" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"></feGaussianBlur></filter>
    <filter id="c4-b8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"></feGaussianBlur></filter>
  </defs>

  <circle cx="150" cy="150" r="150" fill="url(#c4-aura)"></circle>
  <g fill="none" transform="rotate(-90 150 150)">
    <circle class="fr-arc" cx="150" cy="150" r="118" stroke="#E2B552" stroke-width="14" opacity="0.35" filter="url(#c4-b4)"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="118" stroke="url(#c4-gold)" stroke-width="10"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="94" stroke="#3FCFB4" stroke-width="14" opacity="0.35" filter="url(#c4-b4)"></circle>
    <circle class="fr-arc" cx="150" cy="150" r="94" stroke="url(#c4-teal)" stroke-width="10"></circle>
  </g>

  <circle cx="150" cy="150" r="82" fill="url(#c4-disc)"></circle>
  <circle cx="150" cy="150" r="82" fill="url(#c4-discglow)"></circle>

  <g clip-path="url(#c4-clip)">
    <ellipse cx="150" cy="146" rx="58" ry="52" data-fr="glow-fill" fill="#3FCFB4" opacity="0.10" filter="url(#c4-b8)"></ellipse>
    <ellipse cx="152" cy="212" rx="46" ry="6" fill="#000000" opacity="0.7" filter="url(#c4-b4)"></ellipse>
    <ellipse cx="150" cy="209" rx="38" ry="2.5" fill="#000000" opacity="0.6" filter="url(#c4-b1)"></ellipse>

    <path data-fr="shackle" d="M127 142V116a23 23 0 0 1 46 0v26" fill="none" stroke="#2E333B" stroke-width="13.6" stroke-linecap="round"></path>
    <path data-fr="shackle" d="M127 142V116a23 23 0 0 1 46 0v26" fill="none" stroke="url(#c4-shackle)" stroke-width="12" stroke-linecap="round"></path>
    <path data-fr="shackle" d="M127 142V116a23 23 0 0 1 46 0v26" fill="none" stroke="url(#c4-spec)" stroke-width="3" stroke-linecap="round" transform="translate(-2.6 -1.4)"></path>
    <path data-fr="shackle" d="M127 142V116a23 23 0 0 1 46 0v26" fill="none" stroke="#3FCFB4" stroke-opacity="0.45" stroke-width="1.2" transform="translate(5.2 0.6)" filter="url(#c4-b05)"></path>

    <rect x="110" y="138" width="80" height="70" rx="16" fill="url(#c4-edge)"></rect>
    <rect x="113" y="141" width="74" height="64" rx="13" fill="url(#c4-face)"></rect>
    <g clip-path="url(#c4-faceclip)">
      <ellipse cx="130" cy="152" rx="30" ry="12" fill="#FFFFFF" opacity="0.55" transform="rotate(-28 130 152)" filter="url(#c4-b4)"></ellipse>
      <path d="M113 186L152 141H162L113 198Z" fill="#FFFFFF" opacity="0.12"></path>
      <ellipse cx="172" cy="206" rx="34" ry="12" fill="#3B424D" opacity="0.35" filter="url(#c4-b4)"></ellipse>
    </g>
    <rect x="113.6" y="141.6" width="72.8" height="62.8" rx="12.4" fill="none" stroke="url(#c4-facerim)" stroke-width="1.2"></rect>
    <path d="M190 154V192A16 16 0 0 1 174 208" fill="none" stroke="#3FCFB4" stroke-opacity="0.6" stroke-width="1.4" stroke-linecap="round" filter="url(#c4-b05)"></path>
    <ellipse cx="127" cy="139.4" rx="6.4" ry="1.8" fill="#14171B" data-fr="hole" opacity="0"></ellipse>

    <path d="M150 157A8 8 0 0 1 154.6 171.5L156.6 186A2 2 0 0 1 154.6 188.3H145.4A2 2 0 0 1 143.4 186L145.4 171.5A8 8 0 0 1 150 157Z" fill="#FFFFFF" opacity="0.65" transform="translate(0.8 0.9)"></path>
    <path d="M150 157A8 8 0 0 1 154.6 171.5L156.6 186A2 2 0 0 1 154.6 188.3H145.4A2 2 0 0 1 143.4 186L145.4 171.5A8 8 0 0 1 150 157Z" fill="#000000" opacity="0.3" transform="translate(-0.6 -0.7)"></path>
    <path d="M150 157A8 8 0 0 1 154.6 171.5L156.6 186A2 2 0 0 1 154.6 188.3H145.4A2 2 0 0 1 143.4 186L145.4 171.5A8 8 0 0 1 150 157Z" fill="url(#c4-hole)"></path>
    <ellipse cx="150" cy="181" rx="2.6" ry="4.2" data-fr="glow-fill" fill="#3FCFB4" opacity="0.85" filter="url(#c4-b1)"></ellipse>
    <rect x="60" y="60" width="180" height="180" fill="url(#c4-vign)"></rect>
  </g>
  <circle cx="150" cy="150" r="81.5" fill="none" stroke="url(#c4-discrim)" stroke-width="1"></circle>
</svg>`,
};

/** Private only's changing parts, On and Off (the open padlock glows warm). */
export const PRIVATE_ART = {
  on: { shackle: 'M127 142V116a23 23 0 0 1 46 0v26', glow: '#3FCFB4', hole: '0' },
  off: { shackle: 'M173 142V108a23 23 0 0 0-46 0v10', glow: '#FF8A78', hole: '0.85' },
};

/** How much of each ring is lit on each step, as a share of the circle. */
export const LIT = { welcome: 0.25, pay: 0.5, limits: 0.75, private: 1 };

/** The circumference of the gold (r 118) and teal (r 94) rings, as the design's dash lengths use. */
export const RING = { 118: 741.4, 94: 590.6 };
