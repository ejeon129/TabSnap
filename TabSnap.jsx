import { useState, useEffect, useRef, useCallback } from "react";

// ─── FRETBOARD MAPPING ENGINE ───────────────────────────────────────────────
const TUNINGS = {
  standard: { label: "Standard", notes: [64, 59, 55, 50, 45, 40] },  // e B G D A E
  dropD:    { label: "Drop D",   notes: [64, 59, 55, 50, 45, 38] },
  halfDown: { label: "½ Step Down", notes: [63, 58, 54, 49, 44, 39] },
};

const STRING_LABELS = ["e", "B", "G", "D", "A", "E"];

function getCandidates(midiNote, tuning, maxFret = 22) {
  const candidates = [];
  const open = TUNINGS[tuning].notes;
  for (let s = 0; s < 6; s++) {
    const fret = midiNote - open[s];
    if (fret >= 0 && fret <= maxFret) candidates.push({ string: s, fret });
  }
  return candidates;
}

function optimizeChord(candidateSets, lastPositions) {
  if (candidateSets.length === 0) return [];
  if (candidateSets.length === 1) {
    let best = candidateSets[0][0], bestCost = Infinity;
    for (const c of candidateSets[0]) {
      let cost = c.fret * 0.1;
      if (lastPositions.length > 0) {
        cost += Math.min(...lastPositions.map(lp => Math.abs(lp.fret - c.fret) + Math.abs(lp.string - c.string) * 2)) * 0.5;
      }
      if (c.fret === 0) cost -= 0.3;
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return [best];
  }
  let beam = [{ positions: [], cost: 0, used: new Set() }];
  for (const candidates of candidateSets) {
    const next = [];
    for (const state of beam) {
      for (const c of candidates) {
        if (state.used.has(c.string)) continue;
        const frets = [...state.positions.map(p => p.fret), c.fret].filter(f => f > 0);
        const span = frets.length > 0 ? Math.max(...frets) - Math.min(...frets) : 0;
        if (span > 5) continue;
        let cost = state.cost + c.fret * 0.05 + span * 0.3;
        if (c.fret === 0) cost -= 0.2;
        const u = new Set(state.used); u.add(c.string);
        next.push({ positions: [...state.positions, c], cost, used: u });
      }
    }
    next.sort((a, b) => a.cost - b.cost);
    beam = next.slice(0, 20);
  }
  return beam.length > 0 ? beam[0].positions : candidateSets.map(cs => cs[0]).filter(Boolean);
}

function fretboardMap(events, tuning = "standard") {
  const results = [];
  let last = [];
  for (const ev of events) {
    const notes = Array.isArray(ev.notes) ? ev.notes : [ev.notes];
    const candidates = notes.map(n => getCandidates(n, tuning));
    const best = optimizeChord(candidates, last);
    results.push({ time: ev.time, duration: ev.duration, positions: best, chord: ev.chord || null });
    last = best;
  }
  return results;
}

function renderAsciiTab(tabEvents) {
  const PER_LINE = 8;
  const lines = [];
  for (let chunk = 0; chunk < tabEvents.length; chunk += PER_LINE) {
    const slice = tabEvents.slice(chunk, chunk + PER_LINE);
    if (slice.some(e => e.chord)) {
      lines.push("    " + slice.map(e => (e.chord || "").padEnd(6)).join(""));
    }
    for (let s = 0; s < 6; s++) {
      let row = STRING_LABELS[s] + "|";
      for (const ev of slice) {
        const pos = ev.positions.find(p => p.string === s);
        const f = pos !== undefined ? String(pos.fret) : "-";
        row += "-" + f.padEnd(5, "-");
      }
      row += "|";
      lines.push(row);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── DEMO DATA ──────────────────────────────────────────────────────────────
const DEMOS = {
  wonderwall: {
    title: "Wonderwall-style Progression",
    bpm: 87, tuning: "standard",
    events: [
      { time: 0,   duration: 0.5, notes: [40,47,52,55,59,64], chord: "Em7" },
      { time: 0.7, duration: 0.5, notes: [43,47,50,55,59,67], chord: "G" },
      { time: 1.4, duration: 0.5, notes: [50,57,62,66],       chord: "Dsus4" },
      { time: 2.1, duration: 0.5, notes: [45,52,57,64],       chord: "A7sus4" },
      { time: 2.8, duration: 0.5, notes: [40,47,52,55,59,64], chord: "Em7" },
      { time: 3.5, duration: 0.5, notes: [43,47,50,55,59,67], chord: "G" },
      { time: 4.2, duration: 0.5, notes: [50,57,62,66],       chord: "Dsus4" },
      { time: 4.9, duration: 0.5, notes: [45,52,57,64],       chord: "A7sus4" },
    ],
  },
  blues: {
    title: "12-Bar Blues Riff in E",
    bpm: 120, tuning: "standard",
    events: [
      { time: 0,    duration: 0.25, notes: [40] },
      { time: 0.25, duration: 0.25, notes: [40] },
      { time: 0.5,  duration: 0.25, notes: [43] },
      { time: 0.75, duration: 0.25, notes: [40] },
      { time: 1.0,  duration: 0.25, notes: [44] },
      { time: 1.25, duration: 0.25, notes: [43] },
      { time: 1.5,  duration: 0.25, notes: [40] },
      { time: 1.75, duration: 0.25, notes: [45] },
      { time: 2.0,  duration: 0.25, notes: [45] },
      { time: 2.25, duration: 0.25, notes: [45] },
      { time: 2.5,  duration: 0.25, notes: [48] },
      { time: 2.75, duration: 0.25, notes: [45] },
      { time: 3.0,  duration: 0.25, notes: [49] },
      { time: 3.25, duration: 0.25, notes: [48] },
      { time: 3.5,  duration: 0.25, notes: [45] },
      { time: 3.75, duration: 0.25, notes: [40] },
    ],
  },
  fingerpick: {
    title: "Fingerpicking Pattern in Am",
    bpm: 100, tuning: "standard",
    events: [
      { time: 0,   duration: 0.3, notes: [45] },
      { time: 0.3, duration: 0.3, notes: [60] },
      { time: 0.6, duration: 0.3, notes: [57] },
      { time: 0.9, duration: 0.3, notes: [64] },
      { time: 1.2, duration: 0.3, notes: [57] },
      { time: 1.5, duration: 0.3, notes: [60] },
      { time: 1.8, duration: 0.3, notes: [43] },
      { time: 2.1, duration: 0.3, notes: [60] },
      { time: 2.4, duration: 0.3, notes: [55] },
      { time: 2.7, duration: 0.3, notes: [64] },
      { time: 3.0, duration: 0.3, notes: [55] },
      { time: 3.3, duration: 0.3, notes: [60] },
      { time: 3.6, duration: 0.3, notes: [40] },
      { time: 3.9, duration: 0.3, notes: [59] },
      { time: 4.2, duration: 0.3, notes: [55] },
      { time: 4.5, duration: 0.3, notes: [64] },
      { time: 4.8, duration: 0.3, notes: [55] },
      { time: 5.1, duration: 0.3, notes: [59] },
    ],
  },
};

// ─── PALETTE ────────────────────────────────────────────────────────────────
const P = {
  bg: "#08080d", s1: "#101018", s2: "#18182a",
  border: "#222236", bFocus: "#f97316",
  text: "#e8e8f0", muted: "#5e5e78",
  accent: "#f97316", accentSoft: "rgba(249,115,22,0.12)",
  ok: "#34d399", okSoft: "rgba(52,211,153,0.12)",
  err: "#f87171",
};
const SC = ["#f97316","#facc15","#34d399","#38bdf8","#a78bfa","#f472b6"];

// ─── COMPONENT: Tab Grid ────────────────────────────────────────────────────
function TabGrid({ events, activeIdx, onTap }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && activeIdx >= 0) {
      const el = ref.current.querySelector(`[data-c="${activeIdx}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [activeIdx]);

  return (
    <div ref={ref} style={{ overflowX: "auto", paddingBottom: 8 }}>
      <div style={{ display: "inline-flex" }}>
        <div style={{ position: "sticky", left: 0, zIndex: 3, background: P.bg }}>
          <div style={{ height: 26 }} />
          {STRING_LABELS.map((l, i) => (
            <div key={i} style={{
              height: 34, width: 28, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 700, color: SC[i], fontFamily: "monospace",
            }}>{l}</div>
          ))}
        </div>
        {events.map((ev, ci) => {
          const active = ci === activeIdx;
          return (
            <div key={ci} data-c={ci} onClick={() => onTap(ci)} style={{
              display: "flex", flexDirection: "column", cursor: "pointer",
              background: active ? P.accentSoft : "transparent",
              borderRadius: 6, transition: "background 0.12s",
            }}>
              <div style={{
                height: 26, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700, color: P.accent, fontFamily: "monospace",
              }}>{ev.chord || ""}</div>
              {[0,1,2,3,4,5].map(s => {
                const pos = ev.positions.find(p => p.string === s);
                const has = pos !== undefined;
                return (
                  <div key={s} style={{
                    height: 34, minWidth: 44, display: "flex", alignItems: "center", justifyContent: "center",
                    position: "relative", fontFamily: "monospace", fontSize: 14,
                    fontWeight: has ? 700 : 400,
                    color: has ? (active ? "#fff" : SC[s]) : P.border,
                  }}>
                    <div style={{
                      position: "absolute", top: "50%", left: 0, right: 0, height: 1,
                      background: active ? P.border : `${P.border}60`,
                    }} />
                    <span style={{
                      position: "relative", zIndex: 1,
                      background: has && active ? SC[s] : "transparent",
                      borderRadius: 4, padding: "1px 5px",
                      transition: "background 0.12s",
                    }}>
                      {has ? pos.fret : "–"}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── COMPONENT: Pipeline ────────────────────────────────────────────────────
const STAGES = [
  { label: "Download Audio",     active: "Extracting audio...",       done: "Audio extracted" },
  { label: "Source Separation",  active: "Isolating guitar (Demucs)...", done: "Guitar isolated" },
  { label: "Pitch Detection",   active: "Detecting notes...",        done: "MIDI generated" },
  { label: "Fretboard Mapping", active: "Optimizing positions...",   done: "Positions mapped" },
  { label: "Render Tabs",       active: "Building tablature...",     done: "Tabs ready!" },
];

function Pipeline({ stage }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {STAGES.map((s, i) => {
        const done = i < stage, act = i === stage, pend = i > stage;
        return (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 14, padding: "10px 14px",
            background: act ? P.accentSoft : "transparent", borderRadius: 10,
            border: `1px solid ${act ? P.accent + "40" : "transparent"}`,
            transition: "all 0.35s",
          }}>
            <div style={{
              width: 30, height: 30, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              background: done ? P.ok : act ? P.accent : P.s1,
              border: `2px solid ${done ? P.ok : act ? P.accent : P.border}`,
              fontSize: 13, color: done || act ? "#fff" : P.muted, fontWeight: 600,
              transition: "all 0.35s",
            }}>
              {done ? "✓" : act ? <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#fff", animation: "pulse 1s infinite" }} /> : i + 1}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: done ? P.ok : act ? P.text : P.muted }}>{s.label}</div>
              <div style={{ fontSize: 11, color: P.muted }}>{done ? s.done : act ? s.active : "Pending"}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────────────────────
export default function TabSnap() {
  const [url, setUrl] = useState("");
  const [view, setView] = useState("input");
  const [pStage, setPStage] = useState(0);
  const [tab, setTab] = useState(null);
  const [tuning, setTuning] = useState("standard");
  const [activeIdx, setActiveIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [demo, setDemo] = useState("wonderwall");
  const [showAscii, setShowAscii] = useState(false);
  const timerRef = useRef(null);

  const platform = url.includes("tiktok") ? "tiktok" : url.includes("youtu") ? "youtube" : url.includes("instagram") ? "instagram" : null;
  const platMeta = { tiktok: { l: "TikTok", c: "#ff0050", i: "♪" }, youtube: { l: "YouTube", c: "#f00", i: "▶" }, instagram: { l: "Instagram", c: "#e1306c", i: "◎" } };

  const go = useCallback(() => {
    setView("processing"); setPStage(0);
    const delays = [1100, 2200, 1600, 700, 500];
    let s = 0;
    const tick = () => {
      s++;
      if (s < 5) { setPStage(s); setTimeout(tick, delays[s]); }
      else {
        setPStage(5);
        const d = DEMOS[demo];
        const mapped = fretboardMap(d.events, d.tuning);
        const withChords = mapped.map((m, i) => ({ ...m, chord: d.events[i].chord || null }));
        setTab({ title: d.title, bpm: d.bpm, tuning: d.tuning, events: withChords });
        setTimeout(() => setView("result"), 400);
      }
    };
    setTimeout(tick, delays[0]);
  }, [demo]);

  const togglePlay = useCallback(() => {
    if (!tab) return;
    if (playing) { clearInterval(timerRef.current); setPlaying(false); return; }
    setPlaying(true);
    let idx = activeIdx < 0 ? 0 : activeIdx;
    setActiveIdx(idx);
    const ms = (60 / tab.bpm) * 500;
    timerRef.current = setInterval(() => {
      idx++;
      if (idx >= tab.events.length) { clearInterval(timerRef.current); setPlaying(false); setActiveIdx(-1); return; }
      setActiveIdx(idx);
    }, ms);
  }, [playing, tab, activeIdx]);

  const reset = () => {
    setView("input"); setUrl(""); setTab(null); setActiveIdx(-1); setPlaying(false); setPStage(0); setShowAscii(false);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const copyAscii = () => {
    if (!tab) return;
    navigator.clipboard.writeText(renderAsciiTab(tab.events)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const btnBase = { border: "none", cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s" };

  return (
    <div style={{ minHeight: "100vh", background: P.bg, color: P.text, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { height: 5px; } ::-webkit-scrollbar-track { background: ${P.s1}; } ::-webkit-scrollbar-thumb { background: ${P.border}; border-radius: 3px; }
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.7)} }
        @keyframes slideUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
      `}</style>

      {/* HEADER */}
      <header style={{ padding: "16px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${P.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg,${P.accent},#fb923c)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "#fff", fontWeight: 700 }}>⚡</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "'Space Mono', monospace", letterSpacing: "-0.5px" }}>TabSnap</div>
            <div style={{ fontSize: 10, color: P.muted, letterSpacing: "0.8px", textTransform: "uppercase" }}>Short-Form → Guitar Tabs</div>
          </div>
        </div>
        {view !== "input" && <button onClick={reset} style={{ ...btnBase, padding: "7px 14px", borderRadius: 8, border: `1px solid ${P.border}`, background: "transparent", color: P.text, fontSize: 13 }}>← New</button>}
      </header>

      <main style={{ maxWidth: 840, margin: "0 auto", padding: "36px 20px" }}>

        {/* ── INPUT ─────────────────────────────────────────────── */}
        {view === "input" && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <div style={{ textAlign: "center", marginBottom: 44 }}>
              <h1 style={{ fontSize: 36, fontWeight: 700, fontFamily: "'Space Mono', monospace", letterSpacing: "-1.5px", marginBottom: 10, background: `linear-gradient(135deg,${P.text},${P.accent})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                Paste a link. Get tabs.
              </h1>
              <p style={{ color: P.muted, fontSize: 15, maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>
                Drop a TikTok, YouTube Short, or Instagram Reel guitar cover — we'll transcribe it into tablature.
              </p>
            </div>

            <div style={{ background: P.s1, borderRadius: 14, border: `1px solid ${P.border}`, padding: 20, marginBottom: 28 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", background: P.bg, borderRadius: 10, padding: "4px 4px 4px 14px", border: `1px solid ${platform ? platMeta[platform].c + "50" : P.border}`, transition: "border-color 0.3s" }}>
                <span style={{ fontSize: 18, opacity: 0.5 }}>🔗</span>
                <input type="text" placeholder="Paste video URL here..." value={url} onChange={e => setUrl(e.target.value)} style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: P.text, fontSize: 14, padding: "11px 0" }} />
                {platform && <div style={{ padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: platMeta[platform].c + "20", color: platMeta[platform].c, whiteSpace: "nowrap" }}>{platMeta[platform].i} {platMeta[platform].l}</div>}
              </div>

              <div style={{ display: "flex", gap: 6, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: P.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", marginRight: 4 }}>Tuning:</span>
                {Object.entries(TUNINGS).map(([k, v]) => (
                  <button key={k} onClick={() => setTuning(k)} style={{ ...btnBase, padding: "4px 10px", borderRadius: 6, border: `1px solid ${tuning === k ? P.accent : P.border}`, background: tuning === k ? P.accentSoft : "transparent", color: tuning === k ? P.accent : P.muted, fontSize: 11, fontWeight: 600 }}>{v.label}</button>
                ))}
              </div>
            </div>

            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ fontSize: 11, color: P.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: 14 }}>— or try a demo —</div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                {Object.entries(DEMOS).map(([k, s]) => (
                  <button key={k} onClick={() => setDemo(k)} style={{ ...btnBase, padding: "11px 18px", borderRadius: 10, border: `1px solid ${demo === k ? P.accent : P.border}`, background: demo === k ? P.accentSoft : P.s1, color: demo === k ? P.accent : P.text, fontSize: 13, textAlign: "left" }}>
                    <div style={{ fontWeight: 700 }}>{s.title}</div>
                    <div style={{ fontSize: 11, color: P.muted, marginTop: 3 }}>{s.bpm} BPM · {TUNINGS[s.tuning].label}</div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ textAlign: "center" }}>
              <button onClick={go} style={{ ...btnBase, padding: "13px 44px", borderRadius: 10, background: `linear-gradient(135deg,${P.accent},#fb923c)`, color: "#fff", fontSize: 15, fontWeight: 700, boxShadow: `0 4px 20px rgba(249,115,22,0.25)` }}
                onMouseOver={e => e.currentTarget.style.transform = "translateY(-2px)"}
                onMouseOut={e => e.currentTarget.style.transform = "translateY(0)"}
              >⚡ Generate Tabs</button>
            </div>
          </div>
        )}

        {/* ── PROCESSING ───────────────────────────────────────── */}
        {view === "processing" && (
          <div style={{ animation: "slideUp 0.35s ease", maxWidth: 460, margin: "0 auto" }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6, textAlign: "center", fontFamily: "'Space Mono', monospace" }}>Processing...</h2>
            <p style={{ color: P.muted, fontSize: 13, textAlign: "center", marginBottom: 28 }}>
              {url ? `Transcribing from ${platform ? platMeta[platform].l : "URL"}` : `Demo: ${DEMOS[demo].title}`}
            </p>
            <div style={{ background: P.s1, borderRadius: 14, border: `1px solid ${P.border}`, padding: 20 }}>
              <Pipeline stage={pStage} />
            </div>
          </div>
        )}

        {/* ── RESULT ───────────────────────────────────────────── */}
        {view === "result" && tab && (
          <div style={{ animation: "slideUp 0.35s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Space Mono', monospace", letterSpacing: "-0.5px" }}>{tab.title}</h2>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <span style={{ padding: "3px 9px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: P.accentSoft, color: P.accent }}>{tab.bpm} BPM</span>
                  <span style={{ padding: "3px 9px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: P.s2, color: P.muted }}>{TUNINGS[tab.tuning].label}</span>
                  <span style={{ padding: "3px 9px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: P.okSoft, color: P.ok }}>{tab.events.length} notes</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={togglePlay} style={{ ...btnBase, padding: "9px 18px", borderRadius: 8, background: playing ? P.err + "20" : P.accentSoft, border: `1px solid ${playing ? P.err + "40" : P.accent + "40"}`, color: playing ? P.err : P.accent, fontSize: 13, fontWeight: 700 }}>
                  {playing ? "⏹ Stop" : "▶ Play"}
                </button>
                <button onClick={() => setShowAscii(!showAscii)} style={{ ...btnBase, padding: "9px 18px", borderRadius: 8, background: showAscii ? P.s2 : "transparent", border: `1px solid ${P.border}`, color: P.text, fontSize: 13, fontWeight: 600 }}>
                  {showAscii ? "Grid View" : "ASCII View"}
                </button>
                <button onClick={copyAscii} style={{ ...btnBase, padding: "9px 18px", borderRadius: 8, background: "transparent", border: `1px solid ${P.border}`, color: copied ? P.ok : P.text, fontSize: 13, fontWeight: 600 }}>
                  {copied ? "✓ Copied!" : "Copy ASCII"}
                </button>
              </div>
            </div>

            <div style={{ background: P.s1, borderRadius: 14, border: `1px solid ${P.border}`, padding: "16px 12px", marginBottom: 24 }}>
              {showAscii ? (
                <pre style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.6, color: P.text, overflowX: "auto", whiteSpace: "pre", padding: 8 }}>
                  {renderAsciiTab(tab.events)}
                </pre>
              ) : (
                <TabGrid events={tab.events} activeIdx={activeIdx} onTap={setActiveIdx} />
              )}
            </div>

            {/* Legend */}
            <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
              {STRING_LABELS.map((l, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 3, background: SC[i] }} />
                  <span style={{ color: P.muted, fontFamily: "monospace", fontWeight: 600 }}>{l} string</span>
                </div>
              ))}
            </div>

            {/* How it works note */}
            <div style={{ marginTop: 32, padding: "16px 20px", background: P.s1, borderRadius: 10, border: `1px solid ${P.border}`, fontSize: 13, color: P.muted, lineHeight: 1.6 }}>
              <span style={{ fontWeight: 700, color: P.accent }}>ℹ MVP Note:</span> This demo uses pre-defined MIDI data to showcase the fretboard mapping algorithm and tab rendering. 
              The full pipeline (yt-dlp → Demucs → Basic Pitch → fretboard mapper) runs via the Python backend. 
              See the companion <code style={{ background: P.s2, padding: "1px 5px", borderRadius: 3, fontSize: 12 }}>pipeline.py</code> script to run real transcriptions.
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
