// ======== AUDIO CONTEXT =========
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ======== MASTER & TRACK GAINS =========
const masterGain = audioCtx.createGain();
masterGain.gain.value = 1;
masterGain.connect(audioCtx.destination);

const trackGains = {
  kick: audioCtx.createGain(),
  bass: audioCtx.createGain(),
  snare: audioCtx.createGain(),
  chord: audioCtx.createGain()
};
Object.values(trackGains).forEach(g => g.connect(masterGain));

// ======== FX STATE (GLOBAL TOGGLES, PER-TRACK ROUTING) =========
const fxActive = {
  bandpass: false,
  flanger: false,
  phaser: false,
  ringmod: false,
  panner: false,
  reverb: false,
  pitch: false,     // implemented in oscillators for synth sources
  tremolo: false
};

// ======== HELPERS: CREATE LONG IR FOR CONVOLVER (REALISTIC REVERB) ========
function makeImpulseResponse(seconds = 3.5, reverse = false, decay = 3.0) {
  const rate = audioCtx.sampleRate;
  const length = Math.floor(seconds * rate);
  const ir = audioCtx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const channelData = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const n = reverse ? length - i : i;
      // Exponential decay noise tail
      channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
    }
  }
  return ir;
}

// ======== PER-TRACK FX CHAINS (TO AVOID CROSSTALK) =========
function createTrackFxChain(trackKey) {
  // Entry node that all sources from this track feed into
  const entry = audioCtx.createGain();

  // Bandpass filter
  const bandpass = audioCtx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 1200;
  bandpass.Q.value = 1;

  // Phaser: 4 all-pass stages + LFO modulating frequency
  const phaserStages = Array.from({ length: 4 }, () => {
    const ap = audioCtx.createBiquadFilter();
    ap.type = "allpass";
    ap.frequency.value = 700; // base
    ap.Q.value = 0.7;
    return ap;
  });
  const phaserLFO = audioCtx.createOscillator();
  const phaserLFOGain = audioCtx.createGain();
  phaserLFO.frequency.value = 0.5; // Hz
  phaserLFOGain.gain.value = 500;  // sweep ±500Hz
  const phaserCenter = new ConstantSourceNode(audioCtx, { offset: 700 });
  phaserCenter.start();
  phaserLFO.start();
  // Modulate each stage frequency = center + lfo
  phaserStages.forEach(stage => {
    phaserCenter.connect(stage.frequency);
    phaserLFO.connect(phaserLFOGain).connect(stage.frequency);
  });

  // Flanger: short delay + feedback + LFO on delayTime
  const flangerDelay = audioCtx.createDelay();
  flangerDelay.delayTime.value = 0.004; // 4ms base
  const flangerFeedback = audioCtx.createGain();
  flangerFeedback.gain.value = 0.25;
  flangerDelay.connect(flangerFeedback).connect(flangerDelay);
  const flangerLFO = audioCtx.createOscillator();
  const flangerLFOGain = audioCtx.createGain();
  flangerLFO.frequency.value = 0.2; // slow sweep
  flangerLFOGain.gain.value = 0.003; // ±3ms
  flangerLFO.connect(flangerLFOGain).connect(flangerDelay.delayTime);
  flangerLFO.start();

  // Ring Modulator: input -> ringGain, modOsc -> ringGain.gain
  const ringGain = audioCtx.createGain();
  ringGain.gain.value = 0; // will be modulated
  const ringOsc = audioCtx.createOscillator();
  const ringDepth = audioCtx.createGain();
  ringOsc.type = "sine";
  ringOsc.frequency.value = 30; // Hz (metallic if higher)
  ringDepth.gain.value = 1.0;   // ring depth
  ringOsc.connect(ringDepth).connect(ringGain.gain);
  ringOsc.start();

  // Stereo Panner
  const panner = audioCtx.createStereoPanner();
  panner.pan.value = 0; // center

  // Long realistic Reverb
  const convolver = audioCtx.createConvolver();
  convolver.buffer = makeImpulseResponse(3.5, false, 3.0);

  // Tremolo: modulate final gain with LFO
  const tremoloGain = audioCtx.createGain();
  // depth = 1 -> gain oscillates between 0 and 1; we bias with ConstantSource
  const tremoloLFO = audioCtx.createOscillator();
  const tremoloDepth = audioCtx.createGain();
  const tremoloBias = new ConstantSourceNode(audioCtx, { offset: 1.0 - 0.5 }); // 0.5 bias for full depth
  tremoloLFO.frequency.value = 6;  // Hz
  tremoloDepth.gain.value = 0.5;   // 0.5 => full depth contribution
  tremoloLFO.connect(tremoloDepth).connect(tremoloGain.gain);
  tremoloBias.connect(tremoloGain.gain);
  tremoloLFO.start();
  tremoloBias.start();

  // For routing reconstruction
  const nodes = {
    entry,
    bandpass,
    phaserStages,
    flangerDelay,
    ringGain,
    panner,
    convolver,
    tremoloGain
  };

  // Connect fixed internal feedbacks already (done above)
  // We'll (re)wire the linear path from entry -> ... -> trackGain in rebuild function

  // Rebuild the active chain (called when FX toggles change)
  function rebuildRoute() {
    // First, disconnect everything in the linear path from entry outward
    try { entry.disconnect(); } catch {}
    [bandpass, phaserStages[0], phaserStages[1], phaserStages[2], phaserStages[3],
     flangerDelay, ringGain, panner, convolver, tremoloGain].forEach(n => {
      try { n.disconnect(); } catch {}
    });

    // Build ordered list of active nodes
    const activeNodes = [];
    if (fxActive.bandpass) activeNodes.push(bandpass);
    if (fxActive.phaser) activeNodes.push(...phaserStages);
    if (fxActive.flanger) activeNodes.push(flangerDelay);
    if (fxActive.ringmod) activeNodes.push(ringGain);
    if (fxActive.panner) activeNodes.push(panner);
    if (fxActive.reverb) activeNodes.push(convolver);
    if (fxActive.tremolo) activeNodes.push(tremoloGain);

    // Wire: entry -> (active nodes...) -> track gain; if none active: entry -> track gain
    let prev = entry;
    for (const node of activeNodes) {
      prev.connect(node);
      prev = node;
    }
    prev.connect(trackGains[trackKey]);
  }

  // initial route (no FX)
  rebuildRoute();

  return { nodes, rebuildRoute };
}

// Create chains per track
const trackFx = {
  kick: createTrackFxChain("kick"),
  bass: createTrackFxChain("bass"),
  snare: createTrackFxChain("snare"),
  chord: createTrackFxChain("chord")
};

// ======== SOUND GENERATORS (Pitch shift applied here) =========
function playKick(time) {
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();

  osc.type = "sine";
  const base = 150;
  const f = fxActive.pitch ? base * 2 : base;
  osc.frequency.setValueAtTime(f, time);
  osc.frequency.exponentialRampToValueAtTime(0.001, time + 0.5);

  env.gain.setValueAtTime(1, time);
  env.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  osc.connect(env).connect(trackFx.kick.nodes.entry);
  osc.start(time);
  osc.stop(time + 0.5);
}

function playSnare(time) {
  const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer;

  const hp = audioCtx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1000;

  const env = audioCtx.createGain();
  env.gain.setValueAtTime(1, time);
  env.gain.exponentialRampToValueAtTime(0.01, time + 0.2);

  src.connect(hp).connect(env).connect(trackFx.snare.nodes.entry);
  src.start(time);
  src.stop(time + 0.2);
}

function playBass(time) {
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();

  osc.type = "square";
  const base = 55;
  const f = fxActive.pitch ? base * 2 : base;
  osc.frequency.setValueAtTime(f, time);

  env.gain.setValueAtTime(0.5, time);
  env.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  // RingMod expects to multiply the signal; we always feed track entry and routing handles ringmod
  osc.connect(env).connect(trackFx.bass.nodes.entry);
  osc.start(time);
  osc.stop(time + 0.5);
}

function playChord(time) {
  const freqs = [261.63, 329.63, 392.0]; // C major
  freqs.forEach(freq => {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = "sawtooth";
    const f = fxActive.pitch ? freq * 2 : freq;
    osc.frequency.setValueAtTime(f, time);

    env.gain.setValueAtTime(0.2, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + 1.0);

    osc.connect(env).connect(trackFx.chord.nodes.entry);
    osc.start(time);
    osc.stop(time + 1.0);
  });
}

// ======== SEQUENCER =========
const steps = document.querySelectorAll('.step');
let currentStep = 0;
let bpm = 120;
let isPlaying = false;
let timer;

function getInterval() { return (60 / bpm) / 2; } // 8th notes

function scheduler() {
  const now = audioCtx.currentTime;

  document.querySelectorAll('.sequencer').forEach((seq, seqIndex) => {
    const grid = seq.querySelectorAll('.step');
    const step = grid[currentStep];

    grid.forEach(s => s.classList.remove('playing'));
    step.classList.add('playing');

    if (step.classList.contains('active')) {
      if (seqIndex === 0) playKick(now);
      if (seqIndex === 1) playBass(now);
      if (seqIndex === 2) playSnare(now);
      if (seqIndex === 3) playChord(now);
    }
  });

  currentStep = (currentStep + 1) % 8;
  timer = setTimeout(scheduler, getInterval() * 1000);
}

// ======== STEP TOGGLING =========
steps.forEach(step => {
  step.addEventListener('click', () => step.classList.toggle('active'));
});

// ======== TRANSPORT CONTROLS =========
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const tempoSlider = document.getElementById('tempo');
const tempoValue = document.getElementById('tempoValue');

playBtn.addEventListener('click', () => {
  if (!isPlaying) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    isPlaying = true;
    scheduler();
  }
});
stopBtn.addEventListener('click', () => {
  isPlaying = false;
  clearTimeout(timer);
  currentStep = 0;
  document.querySelectorAll('.step').forEach(s => s.classList.remove('playing'));
});
tempoSlider.addEventListener('input', e => {
  bpm = parseInt(e.target.value, 10);
  tempoValue.textContent = bpm;
});

// ======== FX BUTTONS (Global toggles; chains rebuilt per track) =========
const fxButtons = document.querySelectorAll('.fx-btn');

fxButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const fx = btn.dataset.fx;
    fxActive[fx] = !fxActive[fx];
    btn.classList.toggle('active');

    // Special handling for LFO-based modules when toggled
    if (fx === 'tremolo') {
      // nothing extra needed; depth/bias already set; routing includes/excludes tremolo node
    }
    if (fx === 'ringmod') {
      // ringGain.gain is modulated by oscillator; routing includes/excludes this node
    }
    if (fx === 'phaser') {
      // LFO always running; routing includes/excludes phaser stages
    }
    if (fx === 'flanger') {
      // LFO always running; routing includes/excludes flanger delay
    }

    // Rebuild routing for all tracks to reflect the new set of active FX
    Object.values(trackFx).forEach(t => t.rebuildRoute());
  });
});

// ======== VOLUME SLIDERS =========
const volumeSliders = document.querySelectorAll('.volume-slider');
volumeSliders.forEach(slider => {
  slider.addEventListener('input', e => {
    const track = slider.dataset.track;
    const v = parseFloat(e.target.value);
    trackGains[track].gain.value = v;
  });
});
