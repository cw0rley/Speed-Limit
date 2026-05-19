const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, 'assets');
const iconSvg = fs.readFileSync(path.join(assetsDir, 'icon.svg'));

async function generateAssets() {
  // 1. icon.png - 1024x1024 (App Store & Google Play)
  await sharp(iconSvg)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(assetsDir, 'icon.png'));
  console.log('Created icon.png (1024x1024)');

  // 2. adaptive-icon.png - 1024x1024 (Android, no rounded corners)
  const squareSvg = Buffer.from(iconSvg.toString().replace('rx="224"', 'rx="0"'));
  await sharp(squareSvg)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(assetsDir, 'adaptive-icon.png'));
  console.log('Created adaptive-icon.png (1024x1024)');

  // 3. favicon.png - 48x48
  await sharp(iconSvg)
    .resize(48, 48)
    .png()
    .toFile(path.join(assetsDir, 'favicon.png'));
  console.log('Created favicon.png (48x48)');

  // 4. splash.png - 1284x2778 (dark bg with centered icon)
  const splashIcon = await sharp(iconSvg)
    .resize(400, 400)
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: 1284,
      height: 2778,
      channels: 4,
      background: { r: 11, g: 13, b: 18, alpha: 1 }
    }
  })
    .composite([{ input: splashIcon, gravity: 'centre' }])
    .png()
    .toFile(path.join(assetsDir, 'splash.png'));
  console.log('Created splash.png (1284x2778)');

  // 5. feature-graphic.png - 1024x500 (Google Play)
  const featureIcon = await sharp(iconSvg)
    .resize(360, 360)
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: 1024,
      height: 500,
      channels: 4,
      background: { r: 11, g: 13, b: 18, alpha: 1 }
    }
  })
    .composite([{ input: featureIcon, gravity: 'centre' }])
    .png()
    .toFile(path.join(assetsDir, 'feature-graphic.png'));
  console.log('Created feature-graphic.png (1024x500)');
}

generateAssets()
  .then(() => console.log('\nAll assets generated successfully!'))
  .catch(e => { console.error('Error:', e); process.exit(1); });
