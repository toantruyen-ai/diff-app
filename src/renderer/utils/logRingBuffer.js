class LogRingBuffer {
  constructor(capacity = 50000) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0; // next write index
    this.count = 0;
    this.firstSeq = 0;
    this.lastSeq = 0;
  }

  append(logLine) {
    const seq = logLine.seq;
    if (this.count === 0) {
      this.firstSeq = seq;
    }

    if (this.count === this.capacity) {
      // Overwriting oldest element
      this.firstSeq++;
    } else {
      this.count++;
    }

    this.buffer[this.head] = logLine;
    this.head = (this.head + 1) % this.capacity;
    this.lastSeq = seq;
  }

  appendBatch(lines = []) {
    for (const line of lines) {
      this.append(line);
    }
  }

  getItemBySeq(seq) {
    if (seq < this.firstSeq || seq > this.lastSeq || this.count === 0) {
      return null;
    }
    const offsetFromFirst = seq - this.firstSeq;
    if (offsetFromFirst >= this.count) return null;

    const tail = (this.head - this.count + this.capacity) % this.capacity;
    const index = (tail + offsetFromFirst) % this.capacity;
    return this.buffer[index] || null;
  }

  getSlice(startSeq, endSeq) {
    const result = [];
    const fromSeq = Math.max(startSeq, this.firstSeq);
    const toSeq = Math.min(endSeq, this.lastSeq);
    for (let seq = fromSeq; seq <= toSeq; seq++) {
      const item = this.getItemBySeq(seq);
      if (item) result.push(item);
    }
    return result;
  }

  clear() {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
    this.firstSeq = 0;
    this.lastSeq = 0;
  }
}

module.exports = {
  LogRingBuffer,
};
