// ===== AUDIO CONTEXT =====
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ===== MASTER + LIMITER =====
const masterGain = audioCtx.createGain();
masterGain.gain.value = 1;

// Limiter implemented via DynamicsCompressorNode
const limiter = audioCtx.createDynamicsCompressor();
limiter.threshold.value = -6;
limiter.knee.value = 0;
limiter.ratio.value = 20;
limiter.attack.value = 0.003;
limiter.release.value = 0.1;

// Connect master -> limiter -> destination
masterGain.connect(limiter);
limiter.connect(audioCtx.destination);

// ===== FX NODES (shared) =====
const lowpass = audioCtx.createBiquadFilter();
lowpass.type = "lowpass";
lowpass.frequency.value = 20000;

const highpass = audioCtx.createBiquadFilter();
highpass.type = "highpass";
highpass.frequency.value = 20;

const distortion = audioCtx.createWaveShaper();
function makeDistortionCurve(amount = 80) {
  let k = typeof amount === "number" ? amount : 80;
  let n_samples = 44100;
  let curve = new Float32Array(n_samples);
  let deg = Math.PI / 180;
  for (let i = 0; i < n_samples; ++i) {
    let x = (i * 2) / n_samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
distortion.curve = makeDistortionCurve(80);
distortion.oversample = "4x";

const chorus = audioCtx.createDelay();
chorus.delayTime.value = 0.02;
const chorusLFO = audioCtx.createOscillator();
const chorusDepth = audioCtx.createGain();
chorusDepth.gain.value = 0.01;
chorusLFO.frequency.value = 1.5;
chorusLFO.connect(chorusDepth).connect(chorus.delayTime);
chorusLFO.start();

const delayNode = audioCtx.createDelay();
delayNode.delayTime.value = 0.25;
const feedback = audioCtx.createGain();
feedback.gain.value = 0.35;
delayNode.connect(feedback);
feedback.connect(delayNode);

const reverb = audioCtx.createConvolver();
(function fillReverbBuffer() {
  const buffer = audioCtx.createBuffer(2, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    }
  }
  reverb.buffer = buffer;
})();

// Tremolo (gain node modulated by LFO + constant offset)
const tremoloGain = audioCtx.createGain();
tremoloGain.gain.value = 1.0; // will be modulated
const tremLFO = audioCtx.createOscillator();
const tremDepth = audioCtx.createGain();
tremDepth.gain.value = 0.5; // depth (0..0.5)
const tremOffset = audioCtx.createConstantSource();
tremOffset.offset.value = 0.5; // base offset so gain ranges 0..1
tremLFO.frequency.value = 6;
tremLFO.connect(tremDepth).connect(tremoloGain.gain);
tremOffset.connect(tremoloGain.gain);
tremLFO.start();
tremOffset.start();

// Pre-wire FX chain once (order matters here)
lowpass.connect(highpass);
highpass.connect(distortion);
distortion.connect(chorus);
chorus.connect(delayNode);
delayNode.connect(reverb);
reverb.connect(masterGain);

// If there is no FX active for a note, we'll connect directly to masterGain

// ===== FX active map =====
let fxActive = {
  lowpass: false,
  highpass: false,
  distortion: false,
  delay: false,
  reverb: false,
  pitch: false,
  chorus: false,
  tremolo: false
};

// Smooth mute control (not used here but good to have)
function setGlobalMute(state) {
  const now = audioCtx.currentTime;
  if (state) {
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(0, now, 0.01);
  } else {
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(1, now, 0.01);
  }
}

// Determine the first active FX node in chain order (so we can connect a note into it)
function getFirstActiveNode() {
  // Order: lowpass -> highpass -> distortion -> chorus -> delay -> reverb
  if (fxActive.lowpass) return lowpass;
  if (fxActive.highpass) return highpass;
  if (fxActive.distortion) return distortion;
  if (fxActive.chorus) return chorus;
  if (fxActive.delay) return delayNode;
  if (fxActive.reverb) return reverb;
  // tremolo is a modifier (gain), we treat it as an insert in between first node and master
  return null;
}

// Build connection from a per-note gain node to either first active FX or direct to masterGain.
// Returns cleanup function to disconnect that temporary connection.
function connectNoteToFXOrDry(noteGain) {
  // If tremolo active we want to insert tremolo before final masterGain. Implementation:
  // If there are FX active: connect noteGain -> firstActiveNode
  // If no FX active: connect noteGain -> (tremolo or masterGain)
  const first = getFirstActiveNode();
  if (first) {
    noteGain.connect(first);
    return () => {
      try { noteGain.disconnect(first); } catch (e) {}
    };
  } else {
    // no FX active
    if (fxActive.tremolo) {
      // connect to tremoloGain then tremoloGain -> masterGain (tremoloGain already connected via constant/LFO)
      noteGain.connect(tremoloGain);
      tremoloGain.connect(masterGain);
      return () => {
        try { noteGain.disconnect(tremoloGain); tremoloGain.disconnect(masterGain); } catch (e) {}
      };
    } else {
      noteGain.connect(masterGain);
      return () => {
        try { noteGain.disconnect(masterGain); } catch (e) {}
      };
    }
  }
}

// But if there are FX active AND tremolo is active, we want tremolo at the end of the fx chain.
// So ensure tremolo is connected to masterGain or to last fx node when active.
(function wireTremoloIntoChain() {
  // If tremolo is active, ensure tremoloGain is connected to masterGain and rewire reverb -> tremoloGain.
  // To avoid duplicate connects we'll connect reverb to masterGain in init; we'll instead handle dynamically in scheduler cleanup.
  // For simplicity: when tremolo is toggled ON, we connect reverb -> tremoloGain -> masterGain. When OFF, we re-connect reverb -> masterGain.
  // We'll manage this in fx button handler to avoid multiple duplicate connections.
})();

// ===== SOUND GENERATORS (per-note ephemeral output gains) =====
function playKick(time, volume = 1) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(0.001, time + 0.5);

  // apply per-track volume
  const startVol = Math.max(0.0001, volume);
  gain.gain.setValueAtTime(startVol, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  osc.connect(gain);

  const disconnectTemp = connectNoteToFXOrDry(gain);

  osc.start(time);
  osc.stop(time + 0.5);

  setTimeout(() => {
    try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    if (typeof disconnectTemp === "function") disconnectTemp();
  }, (0.5 + 0.05) * 1000);
}

function playSnare(time, volume = 1) {
  const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const noise = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 1000;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(Math.max(0.0001, volume), time);
  gain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);

  noise.connect(filter);
  filter.connect(gain);

  const disconnectTemp = connectNoteToFXOrDry(gain);

  noise.start(time);
  noise.stop(time + 0.2);

  setTimeout(() => {
    try { noise.disconnect(); filter.disconnect(); gain.disconnect(); } catch (e) {}
    if (typeof disconnectTemp === "function") disconnectTemp();
  }, (0.2 + 0.05) * 1000);
}

function playBass(time, volume = 1) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(fxActive.pitch ? 110 : 55, time);

  gain.gain.setValueAtTime(Math.max(0.0001, volume * 0.5), time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  osc.connect(gain);

  const disconnectTemp = connectNoteToFXOrDry(gain);

  osc.start(time);
  osc.stop(time + 0.5);

  setTimeout(() => {
    try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    if (typeof disconnectTemp === "function") disconnectTemp();
  }, (0.5 + 0.05) * 1000);
}

function playChord(time, volume = 1) {
  const freqs = [261.63, 329.63, 392.0]; // C major
  freqs.forEach((freq) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "triangle"; // options are sine, square, sawtooth, triangle
    osc.frequency.setValueAtTime(fxActive.pitch ? freq * 2 : freq, time);

    gain.gain.setValueAtTime(Math.max(0.0001, volume * 0.25), time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 1);

    osc.connect(gain);

    const disconnectTemp = connectNoteToFXOrDry(gain);

    osc.start(time);
    osc.stop(time + 1);

    setTimeout(() => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
      if (typeof disconnectTemp === "function") disconnectTemp();
    }, (1 + 0.05) * 1000);
  });
}

// ===== SEQUENCER =====
const sequenceRows = document.querySelectorAll(".sequencer");
const steps = document.querySelectorAll(".step");
let currentStep = 0;
let bpm = 120;
let isPlaying = false;
let timer;

function getInterval() {
  return (60 / bpm) / 2; // 8th notes
}

function scheduler() {
  const now = audioCtx.currentTime;

  sequenceRows.forEach((seq, seqIndex) => {
    const grid = seq.querySelectorAll(".step");
    const step = grid[currentStep];

    grid.forEach(s => s.classList.remove("playing"));
    step.classList.add("playing");

    if (step.classList.contains("active")) {
      // Read per-track volume slider
      const volSlider = seq.querySelector(".volume-slider");
      const vol = volSlider ? parseFloat(volSlider.value) : 1;

      if (seqIndex === 0) playKick(now, vol);
      if (seqIndex === 1) playBass(now, vol);
      if (seqIndex === 2) playSnare(now, vol);
      if (seqIndex === 3) playChord(now, vol);
    }
  });

  currentStep = (currentStep + 1) % 8;
  timer = setTimeout(scheduler, getInterval() * 1000);
}

// ===== STEP TOGGLING =====
steps.forEach(step => {
  step.addEventListener("click", () => step.classList.toggle("active"));
});

// ===== CONTROLS =====
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const tempoSlider = document.getElementById("tempo");
const tempoValue = document.getElementById("tempoValue");

playBtn.addEventListener("click", async () => {
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  if (!isPlaying) {
    isPlaying = true;
    scheduler();
  }
});

stopBtn.addEventListener("click", () => {
  isPlaying = false;
  clearTimeout(timer);
  currentStep = 0;
  document.querySelectorAll(".step").forEach(s => s.classList.remove("playing"));
});

tempoSlider.addEventListener("input", e => {
  bpm = parseInt(e.target.value, 10);
  tempoValue.textContent = bpm;
});

// ===== FX BUTTONS =====
const fxButtons = document.querySelectorAll(".fx-btn");
fxButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const fx = btn.dataset.fx;
    fxActive[fx] = !fxActive[fx];

    // Special: when tremolo toggled, wire/unwire it to masterGain properly
    if (fx === "tremolo") {
      if (fxActive.tremolo) {
        // connect tremoloGain into chain end: reverb -> tremoloGain -> masterGain
        try {
          reverb.disconnect(masterGain);
        } catch (e) {}
        reverb.connect(tremoloGain);
        tremoloGain.connect(masterGain);
      } else {
        try {
          reverb.disconnect(tremoloGain);
          tremoloGain.disconnect(masterGain);
        } catch (e) {}
        reverb.connect(masterGain);
      }
    }

    // Toggle button UI
    btn.classList.toggle("active", !!fxActive[fx]);
  });
});

// Wire initial end of chain to masterGain (already done earlier for reverb)
reverb.connect(masterGain);
