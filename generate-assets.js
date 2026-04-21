const sharp = require('sharp');
const path = require('path');

const bg = '#0b0d12';
const assetsDir = path.join(__dirname, 'assets');

async function generateAssets() {
  // 1. icon.png - 1024x1024 with 'SL' text
  const iconSvg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
    <rect width="1024" height="1024" fill="${bg}" rx="0" ry="0"/>
    <text x="512" y="580" font-family="Arial, Helvetica, sans-serif" font-size="420" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">SL</text>
  </svg>`;

  await sharp(Buffer.from(iconSvg)).png().toFile(path.join(assetsDir, 'icon.png'));
  console.log('Created icon.png (1024x1024)');

  // 2. adaptive-icon.png - same design as icon
  await sharp(Buffer.from(iconSvg)).png().toFile(path.join(assetsDir, 'adaptive-icon.png'));
  console.log('Created adaptive-icon.png (1024x1024)');

  // 3. splash.png - 1284x2778 with "SPEED LIMIT" centered
  const splashSvg = `<svg width="1284" height="2778" xmlns="http://www.w3.org/2000/svg">
    <rect width="1284" height="2778" fill="${bg}"/>
    <text x="642" y="1310" font-family="Arial, Helvetica, sans-serif" font-size="130" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle" letter-spacing="10">SPEED</text>
    <text x="642" y="1470" font-family="Arial, Helvetica, sans-serif" font-size="130" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle" letter-spacing="10">LIMIT</text>
  </svg>`;

  await sharp(Buffer.from(splashSvg)).png().toFile(path.join(assetsDir, 'splash.png'));
  console.log('Created splash.png (1284x2778)');

  // 4. favicon.png - 48x48 small version
  const faviconSvg = `<svg width="48" height="48" xmlns="http://www.w3.org/2000/svg">
    <rect width="48" height="48" fill="${bg}"/>
    <text x="24" y="28" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">SL</text>
  </svg>`;

  await sharp(Buffer.from(faviconSvg)).png().toFile(path.join(assetsDir, 'favicon.png'));
  console.log('Created favicon.png (48x48)');
}

generateAssets()
  .then(() => console.log('\nAll assets generated successfully!'))
  .catch(e => { console.error('Error:', e); process.exit(1); });
