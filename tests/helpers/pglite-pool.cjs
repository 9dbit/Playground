"use strict";
// Local, disposable PostgreSQL WASM harness. CI also executes the same tests against native PostgreSQL.
const { PGlite } = require("@electric-sql/pglite");
class Pool {
  constructor() {
    this.db = new PGlite();
    this.tail = Promise.resolve();
  }
  async lease() {
    const previous = this.tail;
    let release;
    this.tail = new Promise((r) => (release = r));
    await previous;
    return release;
  }
  async raw(sql, params) {
    await this.db.waitReady;
    let r;
    if (params?.length) r = await this.db.query(sql, params);
    else r = (await this.db.exec(sql)).at(-1) || {};
    return {
      ...r,
      rows: r.rows || [],
      rowCount: r.rows?.length || r.affectedRows || 0,
    };
  }
  async query(sql, params) {
    const release = await this.lease();
    try {
      return await this.raw(sql, params);
    } finally {
      release();
    }
  }
  async connect() {
    const release = await this.lease();
    let returned = false;
    return {
      query: (sql, p) => this.raw(sql, p),
      release: () => {
        if (!returned) {
          returned = true;
          release();
        }
      },
    };
  }
  async end() {
    await this.tail;
    await this.db.close();
  }
}
module.exports = { Pool };
