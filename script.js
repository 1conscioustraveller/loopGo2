// ======== AUDIO CONTEXT =========
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ======== MASTER FX CHAIN =========
const masterGain = audioCtx.createGain();
masterGain.gain.value = 1;
masterGain.connect(audioCtx.destination);

// FX Nodes
const lowpass = audioCtx.createBiquadFilter();
lowpass.type = "lowpass";
lowpass.frequency.value = 20000;

const highpass = audioCtx.createBiquadFilter();
highpass.type = "highpass";
highpass.frequency.value = 20;

const distortion = audioCtx.createWaveShaper();
function makeDistortionCurve(amount = 50) {
  let k = typeof amount === 'number' ? amount : 50;
  let n_samples = 44100;
  let curve = new Float32Array(n_samples);
  let deg = Math.PI / 180;
  for (let i = 0; i < n_samples; ++i) {
    let x = i * 2 / n_samples - 1;
    curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
distortion.curve = makeDistortionCurve(100);
distortion.oversample = '4x';

const delay = audioCtx.createDelay();
delay.delayTime.value = 0.25;
const feedback = audioCtx.createGain();
feedback.gain.value = 0.3;
delay.connect(feedback).connect(delay);

const reverb = audioCtx.createConvolver();
// simple fake impulse response
const reverbBuffer = audioCtx.createBuffer(2, audioCtx.sampleRate * 2, audioCtx.sampleRate);
for (let ch = 0; ch < 2; ch++) {
  const data = reverbBuffer.getChannelData(ch);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
  }
}
reverb.buffer = reverbBuffer;

const chorus = audioCtx.createDelay();
chorus.delayTime.value = 0.03;
const lfo = audioCtx.createOscillator();
const lfoGain = audioCtx.createGain();
lfoGain.gain.value = 0.01;
lfo.frequency.value = 5;
lfo.connect(lfoGain).connect(chorus.delayTime);
lfo.start();

let fxActive = {
  lowpass: false,
  highpass: false,
  distortion: false,
  delay: false,
  reverb: false,
  pitch: false,
  chorus: false,
  mute: false
};

// Build chain dynamically
function buildChain(source) {
  let node = source;

  if (fxActive.lowpass) node = node.connect(lowpass);
  if (fxActive.highpass) node = node.connect(highpass);
  if (fxActive.distortion) node = node.connect(distortion);
  if (fxActive.delay) node = node.connect(delay);
  if (fxActive.reverb) node = node.connect(reverb);
  if (fxActive.chorus) node = node.connect(chorus);

  // Always connect to master
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
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

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
  osc.frequency.setValueAtTime(fxActive.pitch ? 110 : 55, time); // FX6 doubles pitch

  gain.gain.setValueAtTime(0.5, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  osc.connect(gain);
  buildChain(gain);
  osc.start(time);
  osc.stop(time + 0.5);
}

function playChord(time) {
  const freqs = [261.63, 329.63, 392.00]; // C major chord
  freqs.forEach(freq => {
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
const steps = document.querySelectorAll('.step');
let currentStep = 0;
let bpm = 120;
let isPlaying = false;
let timer;

function getInterval() {
  return (60 / bpm) / 2; // 8th notes
}

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
  step.addEventListener('click', () => {
    step.classList.toggle('active');
  });
});

// ======== CONTROLS =========
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const tempoSlider = document.getElementById('tempo');
const tempoValue = document.getElementById('tempoValue');

playBtn.addEventListener('click', () => {
  if (!isPlaying) {
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
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

// ======== FX BUTTONS =========
const fxButtons = document.querySelectorAll('.fx-btn');
fxButtons.forEach((btn, i) => {
  btn.addEventListener('click', () => {
    switch (i) {
      case 0: fxActive.lowpass = !fxActive.lowpass; break;
      case 1: fxActive.highpass = !fxActive.highpass; break;
      case 2: fxActive.distortion = !fxActive.distortion; break;
      case 3: fxActive.delay = !fxActive.delay; break;
      case 4: fxActive.reverb = !fxActive.reverb; break;
      case 5: fxActive.pitch = !fxActive.pitch; break;
      case 6: fxActive.chorus = !fxActive.chorus; break;
      case 7: fxActive.mute = !fxActive.mute;
              masterGain.gain.value = fxActive.mute ? 0 : 1;
              break;
    }
    btn.classList.toggle('active');
  });
});

// ======== RECORDING: 8-BAR LOOPS =========

// Record bus (captures what you hear) + optional mic mix
const recordBus = audioCtx.createMediaStreamDestination();
// Record the post-master mix (i.e., the same as what goes to speakers)
masterGain.connect(recordBus);

// Mic (optional): only mixed into recordings (not into speakers)
let micAddedToRecordBus = false;
let micStream = null;
let micSource = null;
let micGain = null;

async function ensureMicToRecordBus() {
  if (micAddedToRecordBus) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micSource = audioCtx.createMediaStreamSource(micStream);
    micGain = audioCtx.createGain();
    micGain.gain.value = 1.0;
    // Do NOT route mic to speakers to avoid feedback.
    micSource.connect(micGain).connect(recordBus);
    micAddedToRecordBus = true;
  } catch (err) {
    console.warn("Microphone unavailable or denied — recording will only include internal audio.", err);
  }
}

// UI helpers
const recButtons = document.querySelectorAll('.rec-btn');
const loopAudios = [
  document.getElementById('loopAudio0'),
  document.getElementById('loopAudio1'),
  document.getElementById('loopAudio2'),
  document.getElementById('loopAudio3')
];
const loopStatuses = [
  document.getElementById('loopStatus0'),
  document.getElementById('loopStatus1'),
  document.getElementById('loopStatus2'),
  document.getElementById('loopStatus3')
];

function barsToSeconds(bpm, bars = 8, beatsPerBar = 4) {
  return (60 / bpm) * beatsPerBar * bars;
}

function setRecUI(slot, stateText, recording = false, disabled = false) {
  const btn = [...recButtons].find(b => +b.dataset.slot === slot);
  if (!btn) return;
  btn.textContent = recording ? `rec${slot + 1} • REC` : `rec${slot + 1}`;
  btn.classList.toggle('recording', recording);
  btn.disabled = disabled;
  loopStatuses[slot].textContent = stateText;
}

function clearLoop(slot) {
  const audio = loopAudios[slot];
  if (audio.src && audio.src.startsWith('blob:')) {
    URL.revokeObjectURL(audio.src);
  }
  audio.src = '';
  audio.pause();
  audio.currentTime = 0;
  loopStatuses[slot].textContent = 'empty';
}

async function recordEightBars(slot) {
  // Ensure mic (optional)
  await ensureMicToRecordBus();

  // Compute 8-bar duration from current BPM
  const durationSec = barsToSeconds(bpm, 8);
  const durationMs = Math.round(durationSec * 1000);

  if (typeof MediaRecorder === 'undefined') {
    alert('MediaRecorder not supported in this browser.');
    return;
  }

  // Prepare UI
  setRecUI(slot, `arming (${(durationSec).toFixed(2)}s)`, true, true);

  // Create a new recorder on the record bus stream
  let mime = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mime)) {
    mime = 'audio/webm';
  }
  const recorder = new MediaRecorder(recordBus.stream, { mimeType: mime, audioBitsPerSecond: 192000 });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = loopAudios[slot];
    // Cleanup previous blob if any
    if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);

    audio.src = url;
    audio.loop = true;
    loopStatuses[slot].textContent = `ready (${(durationSec).toFixed(2)}s @ ${bpm} BPM)`;
    setRecUI(slot, loopStatuses[slot].textContent, false, false);
  };

  // Start recording exactly now for N seconds
  setRecUI(slot, `recording… (${(durationSec).toFixed(2)}s)`, true, true);
  recorder.start(); // no timeslice; collect at stop

  // Stop automatically after 8 bars
  setTimeout(() => {
    recorder.stop();
  }, durationMs);
}

// Bind rec buttons
recButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const slot = parseInt(btn.dataset.slot, 10);
    recordEightBars(slot);
  });
});

// Loop actions (Play/Stop, Clear)
document.querySelectorAll('.loop-play').forEach(btn => {
  btn.addEventListener('click', () => {
    const slot = parseInt(btn.dataset.slot, 10);
    const audio = loopAudios[slot];
    if (!audio.src) return;
    if (audio.paused) {
      audio.play().catch(() => {}); // ignore autoplay restrictions (button counts as gesture)
      loopStatuses[slot].textContent = 'playing (loop)';
    } else {
      audio.pause();
      audio.currentTime = 0;
      loopStatuses[slot].textContent = 'stopped';
    }
  });
});

document.querySelectorAll('.loop-clear').forEach(btn => {
  btn.addEventListener('click', () => {
    const slot = parseInt(btn.dataset.slot, 10);
    clearLoop(slot);
  });
});
