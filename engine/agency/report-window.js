"use strict";
const { fail } = require('./core');
const ZONE = 'Asia/Jakarta';
function windowQuery(q = {}) {
  const period = q.period || 'daily', sort = q.sort || 'desc';
  if (!['daily','weekly','monthly'].includes(period) || !['asc','desc'].includes(sort)) fail(422,'Periode atau urutan tidak valid');
  for (const name of ['from','to']) if (q[name] && (typeof q[name] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(q[name]) || !Number.isFinite(Date.parse(q[name])) || new Date(q[name]).toISOString().slice(0,10) !== q[name])) fail(422,'Tanggal tidak valid');
  if (q.from && q.to && q.from > q.to) fail(422,'Tanggal akhir harus setelah tanggal awal');
  const offset = Number(q.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) fail(422,'Halaman tidak valid');
  return {period,sort,offset,from:q.from || null,to:q.to || null,timezone:ZONE,unit:{daily:'day',weekly:'week',monthly:'month'}[period]};
}
function dateWhere(column, first = 2) {
  return `($${first}::date IS NULL OR ${column} >= ($${first}::date::timestamp AT TIME ZONE '${ZONE}')) AND ($${first+1}::date IS NULL OR ${column} < (($${first+1}::date+1)::timestamp AT TIME ZONE '${ZONE}'))`;
}
const csvCell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/,"'$&").replace(/"/g,'""') + '"';
function csv(rows, columns) { return '\uFEFF' + [columns.map(csvCell).join(','),...rows.map(row => columns.map(k=>csvCell(row[k] instanceof Date ? row[k].toISOString() : row[k])).join(','))].join('\r\n'); }
module.exports = {windowQuery,dateWhere,csv,ZONE};
