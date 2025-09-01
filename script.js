// ======== AUDIO CONTEXT =========
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ======== MASTER FX CHAIN =========
const masterGain = audioCtx.createGain();
masterGain.gain.value = 1;

// Limiter (prevents volume spikes)
const limiter = audioCtx.createDynamicsCompressor();
limiter.threshold.value = -6; // Start compressing above -6dB
limiter.knee.value = 0;
limiter.ratio.value = 20; // Hard limiting
limiter.attack.value = 0.003;
limiter.release.value = 0.1;

// Always connect master → limiter → destination
masterGain.connect(limiter).connect(audioCtx.destination);

// ======== FX NODES =========
const lowpass = audioCtx.createBiquadFilter();
lowpass.type = "lowpass";
lowpass.frequency.value = 20000;

const highpass = audioCtx.createBiquadFilter();
highpass.type = "highpass";
highpass.frequency.value = 20;

const distortion = audioCtx.createWaveShaper();
function makeDistortionCurve(amount = 100) {
  let k = typeof amount === "number" ? amount : 100;
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

const delay = audioCtx.createDelay();
delay.delayTime.value = 0.25;
const feedback = audioCtx.createGain();
feedback.gain.value = 0.35;
delay.connect(feedback).connect(delay);

const reverb = audioCtx.createConvolver();
const reverbBuffer = audioCtx.createBuffer(2, audioCtx.sampleRate * 2, audioCtx.sampleRate);
for (let ch = 0; ch < 2; ch++) {
  const data = reverbBuffer.getChannelData(ch);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
  }
}
reverb.buffer = reverbBuffer;

const chorus = audioCtx.createDelay();
chorus.delayTime.value = 0.02;
const lfo = audioCtx.createOscillator();
const lfoGain = audioCtx.createGain();
lfoGain.gain.value = 0.01;
lfo.frequency.value = 4;
lfo.connect(lfoGain).connect(chorus.delayTime);
lfo.start();

const tremolo = audioCtx.createGain();
const tremLFO = audioCtx.createOscillator();
const tremDepth = audioCtx.createGain();
tremDepth.gain.value = 0.5;
tremLFO.frequency.value = 6; // 6 Hz wobble
tremLFO.connect(tremDepth).connect(tremolo.gain);
tremLFO.start();

let fxActive = {
  lowpass: false,
  highpass: false,
  distortion: false,
  delay: false,
  reverb: false,
  pitch: false,
  chorus: false,
  tremolo: false,
  mute: false,
};

// ======== BUILD FX CHAIN =========
function buildChain(source) {
  let node = source;

  // Insert FX in series
  if (fxActive.lowpass) node = node.connect(lowpass);
  if (fxActive.highpass) node = node.connect(highpass);
  if (fxActive.distortion) node = node.connect(distortion);
  if (fxActive.delay) node = node.connect(delay);
  if (fxActive.reverb) node = node.connect(reverb);
  if (fxActive.chorus) node = node.connect(chorus);
  if (fxActive.tremolo) node = node.connect(tremolo);

  // Final connection
  node.connect(masterGain);
}

// ======== SOUND GENERATORS =========
function playKick(time) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(0.001, time + 0.5);

  gain.gain.setValueAtTime(1, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  osc.connect(gain);
  buildChain(gain);
  osc.start(time);
  osc.stop(time + 0.5);
}

function playSnare(time) {
  const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const noise = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 1000;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(1, time);
  gain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);

  noise.connect(filter).connect(gain);
  buildChain(gain);
  noise.start(time);
  noise.stop(time + 0.2);
}

function playBass(time) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(fxActive.pitch ? 110 : 55, time);

  gain.gain.setValueAtTime(0.5, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  osc.connect(gain);
  buildChain(gain);
  osc.start(time);
  osc.stop(time + 0.5);
}

function playChord(time) {
  const freqs = [261.63, 329.63, 392.0];
  freqs.forEach((freq) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(fxActive.pitch ? freq * 2 : freq, time);

    gain.gain.setValueAtTime(0.2, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 1);

    osc.connect(gain);
    buildChain(gain);
    osc.start(time);
    osc.stop(time + 1);
  });
}

// ======== SEQUENCER =========
const steps = document.querySelectorAll(".step");
let currentStep = 0;
let bpm = 120;
let isPlaying = false;
let timer;

function getInterval() {
  return 60 / bpm / 2; // 8th notes
}

function scheduler() {
  const now = audioCtx.currentTime;

  document.querySelectorAll(".sequencer").forEach((seq, seqIndex) => {
    const grid = seq.querySelectorAll(".step");
    const step = grid[currentStep];

    grid.forEach((s) => s.classList.remove("playing"));
    step.classList.add("playing");

    if (step.classList.contains("active")) {
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
steps.forEach((step) => {
  step.addEventListener("click", () => {
    step.classList.toggle("active");
  });
});

// ======== CONTROLS =========
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const tempoSlider = document.getElementById("tempo");
const tempoValue = document.getElementById("tempoValue");

playBtn.addEventListener("click", () => {
  if (!isPlaying) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    isPlaying = true;
    scheduler();
  }
});

stopBtn.addEventListener("click", () => {
  isPlaying = false;
  clearTimeout(timer);
  currentStep = 0;
  document.querySelectorAll(".step").forEach((s) => s.classList.remove("playing"));
});

tempoSlider.addEventListener("input", (e) => {
  bpm = parseInt(e.target.value, 10);
  tempoValue.textContent = bpm;
});

// ======== FX BUTTONS =========
const fxButtons = document.querySelectorAll(".fx-btn");
fxButtons.forEach((btn, i) => {
  btn.addEventListener("click", () => {
    switch (i) {
      case 0: fxActive.lowpass = !fxActive.lowpass; break;
      case 1: fxActive.highpass = !fxActive.highpass; break;
      case 2: fxActive.distortion = !fxActive.distortion; break;
      case 3: fxActive.delay = !fxActive.delay; break;
      case 4: fxActive.reverb = !fxActive.reverb; break;
      case 5: fxActive.pitch = !fxActive.pitch; break;
      case 6: fxActive.chorus = !fxActive.chorus; break;
      case 7: fxActive.tremolo = !fxActive.tremolo; break;
    }
    btn.classList.toggle("active");

    // Handle mute separately
    if (btn.textContent.toLowerCase().includes("mute")) {
      fxActive.mute = !fxActive.mute;
      masterGain.gain.value = fxActive.mute ? 0 : 1;
    }
  });
});
