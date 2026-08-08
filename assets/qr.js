/* 極簡 QR 產生器：位元組模式、錯誤更正等級 M、版本 1–10。
   回傳 {size, modules:[[bool]]}。 */
function qrEncode(text){
  /* ── 資料表 ── */
  var EC_M = [
    null,
    { ec:10, g:[[1,16]] },
    { ec:16, g:[[1,28]] },
    { ec:26, g:[[1,44]] },
    { ec:18, g:[[2,32]] },
    { ec:24, g:[[2,43]] },
    { ec:16, g:[[4,27]] },
    { ec:18, g:[[4,31]] },
    { ec:22, g:[[2,38],[2,39]] },
    { ec:22, g:[[3,36],[2,37]] },
    { ec:26, g:[[4,43],[1,44]] }
  ];
  var ALIGN = [null,[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];

  /* ── GF(256) ── */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function(){
    var x = 1;
    for (var i=0;i<255;i++){
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (var j=255;j<512;j++) EXP[j] = EXP[j-255];
  })();
  function gmul(a,b){ return (a===0||b===0) ? 0 : EXP[LOG[a]+LOG[b]]; }

  function rsGenerator(n){
    var poly = [1];
    for (var i=0;i<n;i++){
      var next = new Array(poly.length+1).fill(0);
      for (var j=0;j<poly.length;j++){
        next[j]   ^= poly[j];                  // × x
        next[j+1] ^= gmul(poly[j], EXP[i]);    // × α^i
      }
      poly = next;
    }
    return poly;
  }
  function rsEncode(data, ecLen){
    var gen = rsGenerator(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i=0;i<data.length;i++){
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      for (var j=0;j<ecLen;j++) res[j] ^= gmul(gen[j+1], factor);
    }
    return res;
  }

  /* ── UTF-8 位元組 ── */
  var bytes = Array.prototype.slice.call(new TextEncoder().encode(String(text)));

  /* ── 選版本 ── */
  var version = 0;
  for (var v=1; v<=10; v++){
    var dataCw = EC_M[v].g.reduce(function(s,g){ return s + g[0]*g[1]; }, 0);
    var lenBits = (v <= 9) ? 8 : 16;
    if (4 + lenBits + bytes.length*8 <= dataCw*8){ version = v; break; }
  }
  if (!version) throw new Error('內容過長，超過本產生器支援的容量。');

  var spec = EC_M[version];
  var totalData = spec.g.reduce(function(s,g){ return s + g[0]*g[1]; }, 0);
  var lenBits = (version <= 9) ? 8 : 16;

  /* ── 位元流 ── */
  var bits = [];
  function put(val, n){ for (var i=n-1;i>=0;i--) bits.push((val >> i) & 1); }
  put(4, 4);                    // 位元組模式
  put(bytes.length, lenBits);
  bytes.forEach(function(b){ put(b, 8); });
  var cap = totalData * 8;
  for (var t=0; t<4 && bits.length<cap; t++) bits.push(0);   // 終止符
  while (bits.length % 8) bits.push(0);
  var dataBytes = [];
  for (var i=0;i<bits.length;i+=8){
    var b = 0;
    for (var k=0;k<8;k++) b = (b<<1) | bits[i+k];
    dataBytes.push(b);
  }
  var pad = [0xEC, 0x11], pi = 0;
  while (dataBytes.length < totalData) dataBytes.push(pad[pi++ % 2]);

  /* ── 分塊 + RS + 交錯 ── */
  var blocks = [], ecBlocks = [], pos = 0;
  spec.g.forEach(function(g){
    for (var n=0;n<g[0];n++){
      var chunk = dataBytes.slice(pos, pos + g[1]);
      pos += g[1];
      blocks.push(chunk);
      ecBlocks.push(rsEncode(chunk, spec.ec));
    }
  });
  var maxData = Math.max.apply(null, blocks.map(function(b){ return b.length; }));
  var finalCw = [];
  for (var c=0;c<maxData;c++)
    blocks.forEach(function(b){ if (c < b.length) finalCw.push(b[c]); });
  for (var e=0;e<spec.ec;e++)
    ecBlocks.forEach(function(b){ finalCw.push(b[e]); });

  /* ── 矩陣 ── */
  var size = version*4 + 17;
  var mod = [], reserved = [];
  for (var r=0;r<size;r++){
    mod.push(new Array(size).fill(0));
    reserved.push(new Array(size).fill(false));
  }
  function setF(r,c,val){ mod[r][c] = val ? 1 : 0; reserved[r][c] = true; }

  // 定位圖案 + 分隔區
  [[0,0],[size-7,0],[0,size-7]].forEach(function(p){
    for (var r=-1;r<=7;r++) for (var c=-1;c<=7;c++){
      var rr = p[0]+r, cc = p[1]+c;
      if (rr<0||cc<0||rr>=size||cc>=size) continue;
      var on = (r>=0&&r<=6&&(c===0||c===6)) || (c>=0&&c<=6&&(r===0||r===6)) ||
               (r>=2&&r<=4&&c>=2&&c<=4);
      setF(rr, cc, on);
    }
  });
  // 校正圖案
  var ac = ALIGN[version];
  ac.forEach(function(ar){
    ac.forEach(function(acol){
      if ((ar<=8&&acol<=8) || (ar<=8&&acol>=size-9) || (ar>=size-9&&acol<=8)) return;
      for (var r=-2;r<=2;r++) for (var c=-2;c<=2;c++)
        setF(ar+r, acol+c, Math.max(Math.abs(r),Math.abs(c)) !== 1);
    });
  });
  // 時序圖案
  for (var i2=8;i2<size-8;i2++){ setF(6,i2,i2%2===0); setF(i2,6,i2%2===0); }
  // 固定黑點
  setF(size-8, 8, true);
  // 保留格式資訊區
  for (var i3=0;i3<9;i3++){
    if (!reserved[8][i3]) reserved[8][i3] = true;
    if (!reserved[i3][8]) reserved[i3][8] = true;
  }
  for (var i4=0;i4<8;i4++){
    reserved[8][size-1-i4] = true;
    reserved[size-1-i4][8] = true;
  }
  // 保留版本資訊區
  if (version >= 7){
    for (var r2=0;r2<6;r2++) for (var c2=0;c2<3;c2++){
      reserved[r2][size-11+c2] = true;
      reserved[size-11+c2][r2] = true;
    }
  }

  // 資料填入（Z 字形，跳過第 6 欄）
  var bitIdx = 0;
  var dataBits = [];
  finalCw.forEach(function(b){ for (var i=7;i>=0;i--) dataBits.push((b>>i)&1); });
  var up = true;
  for (var col = size-1; col > 0; col -= 2){
    if (col === 6) col--;
    for (var n2 = 0; n2 < size; n2++){
      var row = up ? size-1-n2 : n2;
      for (var s = 0; s < 2; s++){
        var cc2 = col - s;
        if (reserved[row][cc2]) continue;
        mod[row][cc2] = (bitIdx < dataBits.length) ? dataBits[bitIdx] : 0;
        bitIdx++;
      }
    }
    up = !up;
  }

  /* ── 遮罩 ── */
  function maskFn(m, r, c){
    switch(m){
      case 0: return (r+c)%2===0;
      case 1: return r%2===0;
      case 2: return c%3===0;
      case 3: return (r+c)%3===0;
      case 4: return (Math.floor(r/2)+Math.floor(c/3))%2===0;
      case 5: return (r*c)%2 + (r*c)%3 === 0;
      case 6: return ((r*c)%2 + (r*c)%3)%2===0;
      case 7: return ((r+c)%2 + (r*c)%3)%2===0;
    }
  }
  function fmtBits(mask){
    var v5 = (0 << 3) | mask;            // ECC M = 00
    var rem = v5 << 10;
    for (var i=4;i>=0;i--) if (rem & (1 << (i+10))) rem ^= 0x537 << i;
    return ((v5 << 10) | rem) ^ 0x5412;
  }
  function verBits(){
    var rem = version << 12;
    for (var i=5;i>=0;i--) if (rem & (1 << (i+12))) rem ^= 0x1F25 << i;
    return (version << 12) | rem;
  }
  function applyFormat(grid, mask){
    var f = fmtBits(mask);
    for (var i=0;i<15;i++){
      var bit = (f >> i) & 1;
      // 左上
      if (i < 6)       grid[i][8] = bit;
      else if (i === 6) grid[7][8] = bit;
      else if (i === 7) grid[8][8] = bit;
      else if (i === 8) grid[8][7] = bit;
      else              grid[8][14-i] = bit;
      // 右上 / 左下
      if (i < 8) grid[8][size-1-i] = bit;
      else       grid[size-15+i][8] = bit;
    }
    grid[size-8][8] = 1;
    if (version >= 7){
      var vb = verBits();
      for (var j=0;j<18;j++){
        var b = (vb >> j) & 1;
        grid[Math.floor(j/3)][size-11 + (j%3)] = b;
        grid[size-11 + (j%3)][Math.floor(j/3)] = b;
      }
    }
  }
  function penalty(g){
    var p = 0, i, j, run, prev;
    // 規則 1：同色連續
    for (i=0;i<size;i++){
      run = 1; prev = g[i][0];
      for (j=1;j<size;j++){
        if (g[i][j] === prev) run++;
        else { if (run >= 5) p += 3 + (run-5); run = 1; prev = g[i][j]; }
      }
      if (run >= 5) p += 3 + (run-5);
      run = 1; prev = g[0][i];
      for (j=1;j<size;j++){
        if (g[j][i] === prev) run++;
        else { if (run >= 5) p += 3 + (run-5); run = 1; prev = g[j][i]; }
      }
      if (run >= 5) p += 3 + (run-5);
    }
    // 規則 2：2×2 同色
    for (i=0;i<size-1;i++) for (j=0;j<size-1;j++){
      var a = g[i][j];
      if (a === g[i][j+1] && a === g[i+1][j] && a === g[i+1][j+1]) p += 3;
    }
    // 規則 3：1:1:3:1:1 圖樣
    var pat1 = [1,0,1,1,1,0,1,0,0,0,0], pat2 = [0,0,0,0,1,0,1,1,1,0,1];
    function match(arr, off, pat){
      for (var k=0;k<11;k++) if (arr[off+k] !== pat[k]) return false;
      return true;
    }
    for (i=0;i<size;i++){
      var rowA = g[i], colA = [];
      for (j=0;j<size;j++) colA.push(g[j][i]);
      for (j=0;j+11<=size;j++){
        if (match(rowA,j,pat1) || match(rowA,j,pat2)) p += 40;
        if (match(colA,j,pat1) || match(colA,j,pat2)) p += 40;
      }
    }
    // 規則 4：黑白比例
    var dark = 0;
    for (i=0;i<size;i++) for (j=0;j<size;j++) if (g[i][j]) dark++;
    var pct = dark * 100 / (size*size);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  var best = null, bestScore = Infinity;
  for (var m=0;m<8;m++){
    var g = mod.map(function(row){ return row.slice(); });
    for (var r3=0;r3<size;r3++) for (var c3=0;c3<size;c3++)
      if (!reserved[r3][c3] && maskFn(m, r3, c3)) g[r3][c3] ^= 1;
    applyFormat(g, m);
    var sc = penalty(g);
    if (sc < bestScore){ bestScore = sc; best = g; }
  }
  return { size:size, version:version, modules:best };
}

function qrSvg(text, opts){
  opts = opts || {};
  var q = qrEncode(text);
  var quiet = opts.quiet == null ? 4 : opts.quiet;
  var dim = q.size + quiet*2;
  var d = '';
  for (var r=0;r<q.size;r++){
    for (var c=0;c<q.size;c++){
      if (q.modules[r][c]) d += 'M' + (c+quiet) + ' ' + (r+quiet) + 'h1v1h-1z';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" ' +
         'shape-rendering="crispEdges" role="img" aria-label="QR Code">' +
         '<rect width="' + dim + '" height="' + dim + '" fill="' + (opts.bg || '#fff') + '"/>' +
         '<path d="' + d + '" fill="' + (opts.fg || '#000') + '"/></svg>';
}


