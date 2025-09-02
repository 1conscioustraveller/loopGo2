// === Audio Setup ===
let audioCtx;
let isPlaying = false;
let currentStep = 0;
let tempo = 120;
let intervalId;

const sequencers = {};
const fxNodes = {};

// Sequencer data
const tracks = ["kick", "snare", "bass", "chord"];
const stepsPerSeq = 8;

// === Initialize ===
document.addEventListener("DOMContentLoaded", () => {
  // Build sequencer grids
  tracks.forEach(track => {
    const grid = document.querySelector(`.sequencer[data-type="${track}"] .grid`);
    for (let i = 0; i < stepsPerSeq; i++) {
      const step = document.createElement("div");
      step.classList.add("step");
      step.addEventListener("click", () => step.classList.toggle("active"));
      grid.appendChild(step);
    }
  });

  // Hook controls
  document.getElementById("start").addEventListener("click", start);
  document.getElementById("stop").addEventListener("click", stop);
  document.getElementById("tempo").addEventListener("input", e => tempo = e.target.value);

  // FX toggles
  document.querySelectorAll(".fx-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      toggleFX(btn.dataset.fx, btn.classList.contains("active"));
    });
  });
});

// === Create FX Nodes ===
function createFX() {
  const ctx = audioCtx;
  fxNodes.pitchshift = ctx.createDelay(0.05); // Fake pitch shift (placeholder)
  fxNodes.reverb = ctx.createConvolver();
  fxNodes.bandpass = ctx.createBiquadFilter();
  fxNodes.bandpass.type = "bandpass";
  fxNodes.bandpass.frequency.value = 1000;
  fxNodes.ringmod = ctx.createGain();
  fxNodes.stereopanner = ctx.createStereoPanner();
  fxNodes.delay = ctx.createDelay(5.0);
  fxNodes.delay.delayTime.value = 0.3;
  fxNodes.chorus = ctx.createDelay(0.03);
  fxNodes.autopan = ctx.createOscillator();

  // Generate simple impulse response for reverb
  const irBuffer = ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate);
  for (let ch = 0; ch < irBuffer.numberOfChannels; ch++) {
    const channelData = irBuffer.getChannelData(ch);
    for (let i = 0; i < irBuffer.length; i++) {
      channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irBuffer.length, 2);
    }
  }
  fxNodes.reverb.buffer = irBuffer;
}

// === Toggle FX ===
function toggleFX(name, enabled) {
  // For simplicity, FX are global here
  if (!fxNodes[name]) return;
  if (enabled) {
    fxNodes[name].connect(audioCtx.destination);
  } else {
    fxNodes[name].disconnect();
  }
}

// === Start / Stop ===
function start() {
  if (isPlaying) return;
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    createFX();
    setupTracks();
  }
  isPlaying = true;
  intervalId = setInterval(playStep, (60 / tempo) * 1000);
}

function stop() {
  isPlaying = false;
  clearInterval(intervalId);
  currentStep = 0;
  document.querySelectorAll(".step").forEach(s => s.classList.remove("playing"));
}

// === Setup Tracks ===
function setupTracks() {
  tracks.forEach(track => {
    const gain = audioCtx.createGain();
    gain.connect(audioCtx.destination);
    sequencers[track] = { gain };
    // Hook volume slider
    const vol = document.querySelector(`.sequencer[data-type="${track}"] .volume`);
    vol.addEventListener("input", e => gain.gain.value = e.target.value);
  });
}

// === Play Sequencer ===
function playStep() {
  document.querySelectorAll(".step").forEach(s => s.classList.remove("playing"));

  tracks.forEach(track => {
    const steps = document.querySelectorAll(`.sequencer[data-type="${track}"] .step`);
    const step = steps[currentStep];
    step.classList.add("playing");
    if (step.classList.contains("active")) {
      triggerSound(track);
    }
  });

  currentStep = (currentStep + 1) % stepsPerSeq;
}

// === Trigger Sound ===
function triggerSound(track) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  if (track === "kick") {
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    gain.gain.setValueAtTime(1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
  } else if (track === "snare") {
    osc.type = "triangle";
    osc.frequency.value = 200;
    gain.gain.value = 0.5;
  } else if (track === "bass") {
    osc.type = "square";
    osc.frequency.value = 60;
    gain.gain.value = 0.6;
  } else if (track === "chord") {
    osc.type = "sawtooth";
    osc.frequency.value = 440;
    gain.gain.value = 0.3;
  }

  osc.connect(gain).connect(sequencers[track].gain);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.5);
}
