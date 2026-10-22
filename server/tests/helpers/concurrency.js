// Small helpers for tests that force a particular ORDER of concurrent requests.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const jitter = (max) => sleep(Math.floor(Math.random() * max));

// A gate: `reached` is resolved by the code under test when it arrives at a point; the test then decides
// when to `release` it. Used to freeze one request at an exact step while another request runs.
export const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

// Waits for a gate to be reached, but fails clearly instead of hanging if the code under test never gets there.
export const arrived = (gate) => withDeadline(gate.promise, 10000, 'the expected step (gate not reached)');

export const isPending = async (promise) => Promise.race([promise.then(() => false), sleep(0).then(() => true)]);

// Records how long each phase of a slow test takes, so a long run can be explained instead of just reported.
// Call mark('what just happened') at each phase; report() prints them all as one diagnostic line.
export function timeline() {
  const start = Date.now();
  const marks = [];
  return {
    mark: (label) => marks.push(`${label} @${Math.round((Date.now() - start) / 1000)}s`),
    report: (t) => t.diagnostic(`timeline: ${marks.join(' | ')}`),
  };
}

// Fails (rejects) if `promise` has not settled within `ms`. A timeout is always a FAILURE, never a pass.
// The timer is CLEARED as soon as the promise settles: a forgotten timer keeps the whole test process alive
// until it expires (this once made a 90 s test run for 176 s).
export function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} had not finished within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
