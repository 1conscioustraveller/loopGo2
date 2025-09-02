// loopGo2 script.js
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let currentStep = 0;
let isPlaying = false;
let tempo = 120;
let intervalId;

const sequencerData = [
  { name: "Kick", buffer: null, url: "samples/kick.wav" },
  { name: "Snare", buffer: null, url: "samples/snare.wav" },
  { name: "HiHat", buffer: null, url: "samples/hihat.wav" },
  { name: "Chord", buffer: null, url: "samples/chord.wav" }
];

// Create sequencers
const sequencersDiv = document.getElementById("sequencers");
sequencerData.forEach(seq => {
  const div = document.createElement("div");
  div.className = "sequencer";
  div.innerHTML = `<h2>${seq.name}</h2>`;
  const grid = document.createElement("div");
  grid.className = "grid";
  seq.steps = [];
  for (let i = 0; i < 8; i++) {
    const step = document.createElement("div");
    step.className = "step";
    step.addEventListener("click", () => {
      step.classList.toggle("active");
      seq.steps[i] = !seq.steps[i];
    });
    seq.steps.push(false);
    grid.appendChild(step);
  }
  div.appendChild(grid);
  sequencersDiv.appendChild(div);
});

// Load samples
async function loadSample(url) {
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  return audioCtx.decodeAudioData(arrayBuffer);
}
sequencerData.forEach(async seq => {
  seq.buffer = await loadSample(seq.url);
});

// FX Nodes
const fxNodes = {
  pitchshift: audioCtx.createGain(), // placeholder, real pitchshift would need library
  reverb: audioCtx.createConvolver(),
  bandpass: audioCtx.createBiquadFilter(),
  ringmod: audioCtx.createGain(),
  stereopanner: audioCtx.createStereoPanner(),
  delay: audioCtx.createDelay(5.0),
  chorus: audioCtx.createDelay(0.03),
  autopan: audioCtx.createStereoPanner()
};

// Default settings
fxNodes.bandpass.type = "bandpass";
fxNodes.bandpass.frequency.value = 1000;

fxNodes.ringmod.gain.value = 0.5;

fxNodes.stereopanner.pan.value = 0;

fxNodes.delay.delayTime.value = 0.3;

fxNodes.chorus.delayTime.value = 0.015;

fxNodes.autopan.pan.value = 0;

// Reverb IR (simple impulse generator)
function generateImpulse(duration = 2, decay = 2) {
  const rate = audioCtx.sampleRate;
  const length = rate * duration;
  const impulse = audioCtx.createBuffer(2, length, rate);
  for (let i = 0; i < impulse.numberOfChannels; i++) {
    const channel = impulse.getChannelData(i);
    for (let j = 0; j < length; j++) {
      channel[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / length, decay);
    }
  }
  return impulse;
}
fxNodes.reverb.buffer = generateImpulse();

// Build FX chain
let fxActive = {};
const fxButtons = document.querySelectorAll(".fx-btn");
fxButtons.forEach(btn => {
  fxActive[btn.dataset.fx] = false;
  btn.addEventListener("click", () => {
    fxActive[btn.dataset.fx] = !fxActive[btn.dataset.fx];
    btn.classList.toggle("active", fxActive[btn.dataset.fx]);
  });
});

// Connect FX dynamically
function connectFxChain(source) {
  let node = source;
  Object.keys(fxNodes).forEach(key => {
    if (fxActive[key]) {
      node.connect(fxNodes[key]);
      node = fxNodes[key];
    }
  });
  node.connect(audioCtx.destination);
}

// Scheduler
function playStep() {
  sequencerData.forEach(seq => {
    if (seq.steps[currentStep] && seq.buffer) {
      const source = audioCtx.createBufferSource();
      source.buffer = seq.buffer;

      // Special FX
      if (fxActive.ringmod) {
        const osc = audioCtx.createOscillator();
        const ringGain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = 30;
        osc.connect(ringGain.gain);
        osc.start();
        source.connect(ringGain);
        connectFxChain(ringGain);
      } else {
        connectFxChain(source);
      }

      source.start();
    }
  });

  const allSteps = document.querySelectorAll(".step");
  allSteps.forEach(step => step.classList.remove("playing"));
  document.querySelectorAll(".grid").forEach((grid, idx) => {
    grid.children[currentStep].classList.add("playing");
  });

  currentStep = (currentStep + 1) % 8;
}

function start() {
  if (!isPlaying) {
    isPlaying = true;
    const interval = (60 / tempo) / 2 * 1000;
    intervalId = setInterval(playStep, interval);
  }
}

function stop() {
  isPlaying = false;
  clearInterval(intervalId);
  currentStep = 0;
  document.querySelectorAll(".step").forEach(step => step.classList.remove("playing"));
}

// Controls
document.getElementById("play").addEventListener("click", () => {
  audioCtx.resume();
  start();
});
document.getElementById("stop").addEventListener("click", stop);
document.getElementById("tempo").addEventListener("input", e => {
  tempo = e.target.value;
  document.getElementById("tempoVal").textContent = `${tempo} BPM`;
  if (isPlaying) {
    stop();
    start();
  }
});
