// ===== AUDIO CONTEXT =====
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ===== MASTER + LIMITER =====
const masterGain = audioCtx.createGain();
masterGain.gain.value = 1;

// Limiter implemented via DynamicsCompressorNode tuned as a hard-ish limiter
const limiter = audioCtx.createDynamicsCompressor();
// Tweak these to taste; tighter values = heavier limiting
limiter.threshold.value = -6;   // in dB
limiter.knee.value = 0;
limiter.ratio.value = 20;
limiter.attack.value = 0.001;
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
function makeDistortionCurve(amount = 50) {
  let k = typeof amount === "number" ? amount : 50;
  let n_samples = 44100;
  let curve = new Float32Array(n_samples);
  let deg = Math.PI / 180;
  for (let i = 0; i < n_samples; ++i) {
    let x = (i * 2) / n_samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
distortion.curve = makeDistortionCurve(100);
distortion.oversample = "4x";

const delay = audioCtx.createDelay();
delay.delayTime.value = 0.25;
const feedback = audioCtx.createGain();
feedback.gain.value = 0.3;
delay.connect(feedback);
feedback.connect(delay);

const reverb = audioCtx.createConvolver();
// small fake impulse
(function fillReverb() {
  const reverbBuffer = audioCtx.createBuffer(2, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = reverbBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    }
  }
  reverb.buffer = reverbBuffer;
})();

const chorus = audioCtx.createDelay();
chorus.delayTime.value = 0.03;
const lfo = audioCtx.createOscillator();
const lfoGain = audioCtx.createGain();
lfoGain.gain.value = 0.01;
lfo.frequency.value = 5;
lfo.connect(lfoGain).connect(chorus.delayTime);
lfo.start();

// ===== FX active map (global FX toggles) =====
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

// Smoothly apply/unapply mute on masterGain to avoid clicks
function setGlobalMute(state) {
  const now = audioCtx.currentTime;
  if (state) {
    // ramp down quickly
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(0, now, 0.01);
  } else {
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(1, now, 0.01);
  }
}

// ===== Helpers: safe connect/disconnect per note =====
// buildChainForSource connects a source (typically a Gain node) through either
// the FX chain (if enabled) or straight to master. It returns a small object
// containing a cleanup() function to disconnect nodes once the note ends.
function buildChainForSource(sourceGain, track) {
  // We'll connect sourceGain to either: FX chain -> masterGain OR directly to masterGain.
  // Use local references to avoid surprising external side-effects.
  const connections = [];

  function connectOnce(src, dest) {
    src.connect(dest);
    connections.push({ src, dest });
  }

  if (fxActive[track]) {
    // Chain: sourceGain -> [filters/effects...] -> masterGain
    // We'll chain in series and finally to masterGain.
    // Start from sourceGain and connect to first active FX node in series.
    let current = sourceGain;

    if (fxActive.lowpass) {
      connectOnce(current, lowpass);
      current = lowpass;
    }
    if (fxActive.highpass) {
      connectOnce(current, highpass);
      current = highpass;
    }
    if (fxActive.distortion) {
      connectOnce(current, distortion);
      current = distortion;
    }
    if (fxActive.chorus) {
      connectOnce(current, chorus);
      current = chorus;
    }
    if (fxActive.delay) {
      connectOnce(current, delay);
      current = delay;
    }
    if (fxActive.reverb) {
      connectOnce(current, reverb);
      current = reverb;
    }

    // Final connect to masterGain
    connectOnce(current, masterGain);
  } else {
    // Direct dry path
    connectOnce(sourceGain, masterGain);
  }

  // Return a cleanup function that disconnects the same connections
  return {
    cleanup() {
      // Disconnect in reverse just to be safe
      for (let i = connections.length - 1; i >= 0; i--) {
        try {
          const { src, dest } = connections[i];
          src.disconnect(dest);
        } catch (e) {
          // ignore if already disconnected
        }
      }
    }
  };
}

// ===== SOUND GENERATORS (use ephemeral per-note output gain) =====
function playKick(time, volume = 1) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(0.001, time + 0.5);

  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  osc.connect(gain);

  // Build chain and schedule cleanup after note ends
  const chain = buildChainForSource(gain, fxActive.pitch ? "pitch" : "lowpass"); // not used directly; we'll use explicit mapping later
  // Note: for this app we need the per-track FX mapping; we'll instead build with track name
  chain.cleanup(); // remove the wrong quick call; we'll actually re-call properly below

  // Proper approach: call buildChain with real track name 'kick'
  const realChain = buildChainForSource(gain, "kick");

  osc.start(time);
  osc.stop(time + 0.5);

  // schedule cleanup shortly after stop
  setTimeout(() => {
    try { osc.disconnect(); } catch (e) {}
    realChain.cleanup();
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
  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);

  noise.connect(filter);
  filter.connect(gain);

  const realChain = buildChainForSource(gain, "snare");

  noise.start(time);
  noise.stop(time + 0.2);

  setTimeout(() => {
    try { noise.disconnect(); filter.disconnect(); } catch (e) {}
    realChain.cleanup();
  }, (0.2 + 0.05) * 1000);
}

function playBass(time, volume = 0.5) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(fxActive.pitch ? 110 : 55, time);

  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

  osc.connect(gain);

  const realChain = buildChainForSource(gain, "bass");

  osc.start(time);
  osc.stop(time + 0.5);

  setTimeout(() => {
    try { osc.disconnect(); } catch (e) {}
    realChain.cleanup();
  }, (0.5 + 0.05) * 1000);
}

function playChord(time, volume = 0.2) {
  const freqs = [261.63, 329.63, 392.0]; // C major
  freqs.forEach(freq => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(fxActive.pitch ? freq * 2 : freq, time);

    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 1);

    osc.connect(gain);

    const realChain = buildChainForSource(gain, "chord");

    osc.start(time);
    osc.stop(time + 1);

    setTimeout(() => {
      try { osc.disconnect(); } catch (e) {}
      realChain.cleanup();
    }, (1 + 0.05) * 1000);
  });
}

// ===== SEQUENCER LOGIC =====
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

  document.querySelectorAll(".sequencer").forEach((seq, seqIndex) => {
    const grid = seq.querySelectorAll(".step");
    const step = grid[currentStep];

    grid.forEach(s => s.classList.remove("playing"));
    step.classList.add("playing");

    if (step.classList.contains("active")) {
      // fetch per-track volume slider value
      const track = ["kick", "bass", "snare", "chord"][seqIndex];
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

// ===== STEP INTERACTIONS =====
steps.forEach(step => {
  step.addEventListener("click", () => step.classList.toggle("active"));
});

// ===== CONTROLS =====
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const tempoSlider = document.getElementById("tempo");
const tempoValue = document.getElementById("tempoValue");

playBtn.addEventListener("click", async () => {
  // AudioContext must be resumed by user interaction in many browsers
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

// ===== FX BUTTONS (global toggles) =====
const fxButtons = document.querySelectorAll(".fx-btn");
fxButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const fx = btn.dataset.fx;
    fxActive[fx] = !fxActive[fx];

    // Special handling for mute (do smooth ramp)
    if (fx === "mute") {
      setGlobalMute(fxActive.mute);
    }

    btn.classList.toggle("active", fxActive[fx]);
  });
});

// Ensure volume sliders are wired (they are read by scheduler)
document.querySelectorAll(".volume-slider").forEach(sl => {
  sl.addEventListener("input", () => {
    // nothing extra to do; scheduler reads values when triggering notes
  });
});
