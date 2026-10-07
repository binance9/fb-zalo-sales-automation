'use strict';
// csv-import.js — BULK IMPORT CSV sản phẩm (PHASE PRODUCT-READY).
//
// POST /api/products/import {csv} — cột: name,sku,price,stock,size,color,weight
//   - Dòng đầu là HEADER (name/sku bắt buộc có trong header; thứ tự cột tùy ý).
//   - Hỗ trợ ngoặc kép "" (dấu phẩy trong ô), CRLF, BOM.
//   - Trả { rows, errors:[{line, error}] } — dòng lỗi KHÔNG chặn dòng đúng (import từng dòng hợp lệ).

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // "" -> "
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function normHeader(h) { return String(h || '').trim().toLowerCase(); }

// Trả { rows:[{name,sku,price,stock,size,color,weight}], errors:[{line,error}] }
function parseProductsCsv(csv) {
  const text = String(csv || '').replace(/^\uFEFF/, '');
  const rawLines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows = [];
  const errors = [];
  if (!rawLines.length) return { rows, errors: [{ line: 0, error: 'CSV_TRONG' }] };

  const header = splitCsvLine(rawLines[0]).map(normHeader);
  const idx = {
    name: header.indexOf('name'),
    sku: header.indexOf('sku'),
    price: header.indexOf('price'),
    stock: header.indexOf('stock'),
    size: header.indexOf('size'),
    color: header.indexOf('color'),
    weight: header.indexOf('weight'),
  };
  if (idx.name < 0 || idx.sku < 0) {
    return { rows, errors: [{ line: 1, error: 'HEADER_THIEU_COT name/sku (cần: name,sku,price,stock,size,color,weight)' }] };
  }
  for (let i = 1; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const cells = splitCsvLine(rawLines[i]);
    const name = cells[idx.name] || '';
    const sku = (cells[idx.sku] || '').toUpperCase().replace(/\s+/g, '-');
    if (!name) { errors.push({ line: lineNo, error: 'THIEU_TEN' }); continue; }
    if (!sku) { errors.push({ line: lineNo, error: 'THIEU_SKU' }); continue; }
    const price = Math.round(Number(cells[idx.price]));
    if (!Number.isFinite(price) || price <= 0) { errors.push({ line: lineNo, error: 'GIA_KHONG_HOP_LE' }); continue; }
    let stock = 0;
    if (idx.stock >= 0 && cells[idx.stock] !== undefined && cells[idx.stock] !== '') {
      stock = Math.round(Number(cells[idx.stock]));
      if (!Number.isFinite(stock) || stock < 0) { errors.push({ line: lineNo, error: 'TON_KHO_KHONG_HOP_LE' }); continue; }
    }
    let weight = null;
    if (idx.weight >= 0 && cells[idx.weight] !== undefined && cells[idx.weight] !== '') {
      weight = Math.round(Number(cells[idx.weight]));
      if (!Number.isFinite(weight) || weight <= 0) { errors.push({ line: lineNo, error: 'CAN_NANG_KHONG_HOP_LE' }); continue; }
    }
    rows.push({
      name,
      sku_base: sku,
      price,
      stock_qty: stock,
      size: idx.size >= 0 ? (cells[idx.size] || 'free') : 'free',
      color: idx.color >= 0 ? (cells[idx.color] || null) : null,
      weight_g: weight,
    });
  }
  return { rows, errors };
}

module.exports = { parseProductsCsv, splitCsvLine };
