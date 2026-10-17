'use strict';

const fs = require('node:fs');
const path = require('node:path');

// In-memory store, optionally persisted as a single JSON file under DATA_DIR.
class Store {
  constructor(dataDir) {
    this.groups = new Map();
    this.file = dataDir ? path.join(dataDir, 'data.json') : null;
    if (this.file) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        const raw = fs.readFileSync(this.file, 'utf8');
        for (const g of JSON.parse(raw).groups || []) this.groups.set(g.id, g);
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('failed to load data:', err.message);
      }
    }
  }

  get(id) {
    return this.groups.get(id);
  }

  put(group) {
    this.groups.set(group.id, group);
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ groups: [...this.groups.values()] }));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
