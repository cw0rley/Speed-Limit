const sharp = require('sharp');
const path = require('path');

async function generate() {
  // iPhone 6.7" (1290x2796) - Portrait
  const portrait67 = `<svg width="1290" height="2796" xmlns="http://www.w3.org/2000/svg">
    <rect width="1290" height="1398" fill="#0b0d12"/>
    <rect y="1398" width="1290" height="1398" fill="#ffffff"/>
    <text x="645" y="500" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="bold" fill="#aaaaaa" text-anchor="middle" letter-spacing="8">CURRENT SPEED</text>
    <text x="645" y="900" font-family="Arial, Helvetica, sans-serif" font-size="480" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">47</text>
    <text x="645" y="1600" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="bold" fill="#666666" text-anchor="middle" letter-spacing="8">SPEED LIMIT</text>
    <text x="645" y="2000" font-family="Arial, Helvetica, sans-serif" font-size="480" font-weight="800" fill="#000000" text-anchor="middle" dominant-baseline="middle">45</text>
    <rect x="40" y="2580" width="120" height="55" rx="10" fill="none" stroke="#000" stroke-width="3"/>
    <text x="100" y="2615" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#000" text-anchor="middle">MPH</text>
    <text x="645" y="2600" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#333" text-anchor="middle">GPS +/- 3 m</text>
    <text x="645" y="2635" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#999" text-anchor="middle">Limit Data: HERE</text>
    <text x="1130" y="2600" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#666" text-anchor="middle">Screen on</text>
    <rect x="1090" y="2615" width="80" height="40" rx="20" fill="#34c759"/>
    <circle cx="1150" cy="2635" r="16" fill="white"/>
  </svg>`;
  await sharp(Buffer.from(portrait67)).png().toFile(path.join('assets', 'screenshot-67-portrait.png'));
  console.log('Created 6.7 portrait');

  // iPhone 6.7" - Portrait OVER LIMIT
  const portraitOver67 = `<svg width="1290" height="2796" xmlns="http://www.w3.org/2000/svg">
    <rect width="1290" height="1398" fill="#0b0d12"/>
    <rect y="1398" width="1290" height="1398" fill="#ffffff"/>
    <text x="645" y="500" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="bold" fill="#aaaaaa" text-anchor="middle" letter-spacing="8">CURRENT SPEED</text>
    <text x="645" y="900" font-family="Arial, Helvetica, sans-serif" font-size="480" font-weight="800" fill="#ff2020" text-anchor="middle" dominant-baseline="middle">52</text>
    <text x="645" y="1600" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="bold" fill="#666666" text-anchor="middle" letter-spacing="8">SPEED LIMIT</text>
    <text x="645" y="2000" font-family="Arial, Helvetica, sans-serif" font-size="480" font-weight="800" fill="#000000" text-anchor="middle" dominant-baseline="middle">45</text>
    <rect x="40" y="2580" width="120" height="55" rx="10" fill="none" stroke="#000" stroke-width="3"/>
    <text x="100" y="2615" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#000" text-anchor="middle">MPH</text>
    <text x="645" y="2600" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#333" text-anchor="middle">GPS +/- 2 m   OVER LIMIT</text>
    <text x="645" y="2635" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#999" text-anchor="middle">Limit Data: HERE</text>
    <text x="1130" y="2600" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#666" text-anchor="middle">Screen on</text>
    <rect x="1090" y="2615" width="80" height="40" rx="20" fill="#34c759"/>
    <circle cx="1150" cy="2635" r="16" fill="white"/>
  </svg>`;
  await sharp(Buffer.from(portraitOver67)).png().toFile(path.join('assets', 'screenshot-67-over.png'));
  console.log('Created 6.7 over limit');

  // iPhone 6.7" - Landscape (2796x1290)
  const landscape67 = `<svg width="2796" height="1290" xmlns="http://www.w3.org/2000/svg">
    <rect width="1398" height="1290" fill="#0b0d12"/>
    <rect x="1398" width="1398" height="1290" fill="#ffffff"/>
    <text x="699" y="350" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="bold" fill="#aaaaaa" text-anchor="middle" letter-spacing="8">CURRENT SPEED</text>
    <text x="699" y="700" font-family="Arial, Helvetica, sans-serif" font-size="380" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">47</text>
    <text x="2097" y="350" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="bold" fill="#666666" text-anchor="middle" letter-spacing="8">SPEED LIMIT</text>
    <text x="2097" y="700" font-family="Arial, Helvetica, sans-serif" font-size="380" font-weight="800" fill="#000000" text-anchor="middle" dominant-baseline="middle">45</text>
    <rect x="40" y="1130" width="120" height="55" rx="10" fill="none" stroke="#fff" stroke-width="3"/>
    <text x="100" y="1165" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">MPH</text>
    <text x="1398" y="1155" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#ddd" text-anchor="middle">GPS +/- 3 m</text>
    <text x="1398" y="1190" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#777" text-anchor="middle">Limit Data: HERE</text>
    <text x="2530" y="1155" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#ccc" text-anchor="middle">Screen on</text>
    <rect x="2590" y="1130" width="80" height="40" rx="20" fill="#34c759"/>
    <circle cx="2650" cy="1150" r="16" fill="white"/>
  </svg>`;
  await sharp(Buffer.from(landscape67)).png().toFile(path.join('assets', 'screenshot-67-landscape.png'));
  console.log('Created 6.7 landscape');

  // 6.5" versions (1242x2688 portrait)
  const portrait65 = `<svg width="1242" height="2688" xmlns="http://www.w3.org/2000/svg">
    <rect width="1242" height="1344" fill="#0b0d12"/>
    <rect y="1344" width="1242" height="1344" fill="#ffffff"/>
    <text x="621" y="480" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="bold" fill="#aaaaaa" text-anchor="middle" letter-spacing="8">CURRENT SPEED</text>
    <text x="621" y="870" font-family="Arial, Helvetica, sans-serif" font-size="460" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">47</text>
    <text x="621" y="1540" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="bold" fill="#666666" text-anchor="middle" letter-spacing="8">SPEED LIMIT</text>
    <text x="621" y="1930" font-family="Arial, Helvetica, sans-serif" font-size="460" font-weight="800" fill="#000000" text-anchor="middle" dominant-baseline="middle">45</text>
    <rect x="40" y="2480" width="120" height="55" rx="10" fill="none" stroke="#000" stroke-width="3"/>
    <text x="100" y="2515" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#000" text-anchor="middle">MPH</text>
    <text x="621" y="2500" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#333" text-anchor="middle">GPS +/- 3 m</text>
    <text x="621" y="2535" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#999" text-anchor="middle">Limit Data: HERE</text>
    <text x="1090" y="2500" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#666" text-anchor="middle">Screen on</text>
    <rect x="1050" y="2515" width="80" height="40" rx="20" fill="#34c759"/>
    <circle cx="1110" cy="2535" r="16" fill="white"/>
  </svg>`;
  await sharp(Buffer.from(portrait65)).png().toFile(path.join('assets', 'screenshot-65-portrait.png'));
  console.log('Created 6.5 portrait');

  // 6.5" Landscape (2688x1242)
  const landscape65 = `<svg width="2688" height="1242" xmlns="http://www.w3.org/2000/svg">
    <rect width="1344" height="1242" fill="#0b0d12"/>
    <rect x="1344" width="1344" height="1242" fill="#ffffff"/>
    <text x="672" y="340" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="bold" fill="#aaaaaa" text-anchor="middle" letter-spacing="8">CURRENT SPEED</text>
    <text x="672" y="680" font-family="Arial, Helvetica, sans-serif" font-size="360" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">47</text>
    <text x="2016" y="340" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="bold" fill="#666666" text-anchor="middle" letter-spacing="8">SPEED LIMIT</text>
    <text x="2016" y="680" font-family="Arial, Helvetica, sans-serif" font-size="360" font-weight="800" fill="#000000" text-anchor="middle" dominant-baseline="middle">45</text>
    <rect x="40" y="1090" width="120" height="55" rx="10" fill="none" stroke="#fff" stroke-width="3"/>
    <text x="100" y="1125" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">MPH</text>
    <text x="1344" y="1115" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#ddd" text-anchor="middle">GPS +/- 3 m</text>
    <text x="1344" y="1150" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#777" text-anchor="middle">Limit Data: HERE</text>
    <text x="2430" y="1115" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#ccc" text-anchor="middle">Screen on</text>
    <rect x="2490" y="1090" width="80" height="40" rx="20" fill="#34c759"/>
    <circle cx="2550" cy="1110" r="16" fill="white"/>
  </svg>`;
  await sharp(Buffer.from(landscape65)).png().toFile(path.join('assets', 'screenshot-65-landscape.png'));
  console.log('Created 6.5 landscape');
}

generate().then(() => console.log('All screenshots done!')).catch(e => console.error(e));
