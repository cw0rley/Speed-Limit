const sharp = require('sharp');
const path = require('path');

const DOWNLOADS = 'C:/Users/pat/Downloads';
const ASSETS = path.join(__dirname, 'assets');

async function generate() {
  const portraitSrc = path.join(DOWNLOADS, 'IMG_3003.png');
  const landscapeSrc = path.join(DOWNLOADS, 'IMG_3002.png');

  const pMeta = await sharp(portraitSrc).metadata();
  const lMeta = await sharp(landscapeSrc).metadata();

  // Portrait 960x2079:
  // Cover everything from y=70 down through the "0" area
  // Then redraw the "CURRENT SPEED" label + new speed number
  const portraitVariants = [
    { speed: '33', color: '#ffffff', file: 'screenshot-portrait-normal.png' },
    { speed: '38', color: '#FFD700', file: 'screenshot-portrait-yellow.png' },
    { speed: '43', color: '#FF8C00', file: 'screenshot-portrait-orange.png' },
    { speed: '46', color: '#FF0000', file: 'screenshot-portrait-red.png' },
  ];

  for (const v of portraitVariants) {
    const overlay = Buffer.from(`<svg width="${pMeta.width}" height="${pMeta.height}">
      <rect x="0" y="70" width="${pMeta.width}" height="580" fill="#0b0d12"/>
      <text x="${pMeta.width / 2}" y="110" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="#aaaaaa" text-anchor="middle" letter-spacing="5">CURRENT SPEED</text>
      <text x="${pMeta.width / 2}" y="440" font-family="Arial, Helvetica, sans-serif" font-size="340" font-weight="800" fill="${v.color}" text-anchor="middle">${v.speed}</text>
    </svg>`);

    const composited = await sharp(portraitSrc)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .toBuffer();

    await sharp(composited)
      .resize(1242, 2688, { fit: 'fill' })
      .toFile(path.join(ASSETS, v.file.replace('.png', '-65.png')));

    await sharp(composited)
      .resize(1290, 2796, { fit: 'fill' })
      .toFile(path.join(ASSETS, v.file.replace('.png', '-67.png')));

    console.log(`Created ${v.file}`);
  }

  // Landscape 2079x960:
  const landscapeVariants = [
    { speed: '33', color: '#ffffff', file: 'screenshot-landscape-normal.png' },
    { speed: '46', color: '#FF0000', file: 'screenshot-landscape-red.png' },
  ];

  for (const v of landscapeVariants) {
    const halfW = Math.floor(lMeta.width / 2);
    const overlay = Buffer.from(`<svg width="${lMeta.width}" height="${lMeta.height}">
      <rect x="0" y="140" width="${halfW}" height="540" fill="#0b0d12"/>
      <text x="${halfW / 2}" y="185" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="#aaaaaa" text-anchor="middle" letter-spacing="5">CURRENT SPEED</text>
      <text x="${halfW / 2}" y="500" font-family="Arial, Helvetica, sans-serif" font-size="300" font-weight="800" fill="${v.color}" text-anchor="middle">${v.speed}</text>
    </svg>`);

    const composited = await sharp(landscapeSrc)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .toBuffer();

    await sharp(composited)
      .resize(2688, 1242, { fit: 'fill' })
      .toFile(path.join(ASSETS, v.file.replace('.png', '-65.png')));

    await sharp(composited)
      .resize(2796, 1290, { fit: 'fill' })
      .toFile(path.join(ASSETS, v.file.replace('.png', '-67.png')));

    console.log(`Created ${v.file}`);
  }
}

generate().then(() => console.log('All done!')).catch(e => console.error(e));
