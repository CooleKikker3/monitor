const MINUTE = 60 * 1000;
const RECENT_MS = 60 * MINUTE;
const MAX_POINTS = 400;

/**
 * Time series with two resolutions: raw samples for the last hour and
 * per-minute aggregates up to the retention period. Rows are compact arrays
 * whose first element is the timestamp; `aggregate(rows, start)` merges rows
 * into one row starting at `start`.
 */
class Series {
  constructor({ aggregate, retentionMs, intervalMs }) {
    this.aggregate = aggregate;
    this.retentionMs = retentionMs;
    this.intervalMs = intervalMs;
    this.recent = [];
    this.minutes = [];
    this.bucket = null;
  }

  load(minutes) {
    if (Array.isArray(minutes)) this.minutes = minutes;
    this.prune();
  }

  /** Adds a sample. Returns true when a finished minute was appended. */
  add(row) {
    this.recent.push(row);
    const minuteStart = Math.floor(row[0] / MINUTE) * MINUTE;
    let flushed = false;
    if (this.bucket && this.bucket.start !== minuteStart) flushed = this.flush();
    if (!this.bucket) this.bucket = { start: minuteStart, rows: [] };
    this.bucket.rows.push(row);
    this.prune();
    return flushed;
  }

  flush() {
    const b = this.bucket;
    this.bucket = null;
    if (!b || !b.rows.length) return false;
    this.minutes.push(this.aggregate(b.rows, b.start));
    return true;
  }

  prune() {
    dropBefore(this.minutes, Date.now() - this.retentionMs);
    dropBefore(this.recent, Date.now() - RECENT_MS);
  }

  /** Returns rows for a time range, downsampled to at most ~400 points. */
  history(rangeMs) {
    const from = Date.now() - rangeMs;

    if (rangeMs <= RECENT_MS) {
      return { bucketMs: this.intervalMs, points: withGaps(this.recent.filter((r) => r[0] >= from), this.intervalMs) };
    }

    const source = this.minutes.filter((r) => r[0] >= from);
    // Include the minute in progress so the chart reaches "now"
    if (this.bucket && this.bucket.rows.length) source.push(this.aggregate(this.bucket.rows, this.bucket.start));

    const bucketMs = Math.max(MINUTE, Math.ceil(rangeMs / MAX_POINTS / MINUTE) * MINUTE);
    if (bucketMs === MINUTE) return { bucketMs, points: withGaps(source, bucketMs) };

    const groups = new Map();
    for (const r of source) {
      const key = Math.floor(r[0] / bucketMs) * bucketMs;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const points = [...groups.entries()].map(([start, rows]) => this.aggregate(rows, start));
    return { bucketMs, points: withGaps(points, bucketMs) };
  }
}

function dropBefore(rows, cutoff) {
  let i = 0;
  while (i < rows.length && rows[i][0] < cutoff) i++;
  if (i) rows.splice(0, i);
}

// Insert a null row where data is missing (server was down) so lines break there
function withGaps(rows, stepMs) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && rows[i][0] - rows[i - 1][0] > stepMs * 2.5) {
      out.push([rows[i - 1][0] + stepMs, ...new Array(rows[i].length - 1).fill(null)]);
    }
    out.push(rows[i]);
  }
  return out;
}

function round(n, d = 1) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

const avgOf = (rows, i) => {
  const vals = rows.map((r) => r[i]).filter((v) => v != null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
};
const maxOf = (rows, i) => {
  const vals = rows.map((r) => r[i]).filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
};

module.exports = { Series, round, avgOf, maxOf, MINUTE };
