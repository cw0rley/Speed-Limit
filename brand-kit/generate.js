const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const assetsDir = path.join(__dirname, '..', 'assets');
const iconSvg = fs.readFileSync(path.join(dir, 'icon-v2.svg'));

async function generate() {
  const targets = [dir, assetsDir];

  // 1. icon.png - 1024x1024
  for (const t of targets) {
    await sharp(iconSvg).resize(1024, 1024).png().toFile(path.join(t, 'icon.png'));
  }
  console.log('icon.png (1024x1024)');

  // 2. adaptive-icon.png - 1024x1024 square corners
  const squareSvg = Buffer.from(iconSvg.toString().replace('rx="224"', 'rx="0"'));
  for (const t of targets) {
    await sharp(squareSvg).resize(1024, 1024).png().toFile(path.join(t, 'adaptive-icon.png'));
  }
  console.log('adaptive-icon.png (1024x1024)');

  // 3. favicon.png - 48x48
  for (const t of targets) {
    await sharp(iconSvg).resize(48, 48).png().toFile(path.join(t, 'favicon.png'));
  }
  console.log('favicon.png (48x48)');

  // 4. splash.png - 1284x2778
  const splashIcon = await sharp(iconSvg).resize(400, 400).png().toBuffer();
  for (const t of targets) {
    await sharp({
      create: { width: 1284, height: 2778, channels: 4, background: { r: 11, g: 13, b: 18, alpha: 1 } }
    }).composite([{ input: splashIcon, gravity: 'centre' }]).png().toFile(path.join(t, 'splash.png'));
  }
  console.log('splash.png (1284x2778)');

  // 5. feature-graphic.png - 1024x500 (Google Play)
  const featureIcon = await sharp(iconSvg).resize(360, 360).png().toBuffer();
  for (const t of targets) {
    await sharp({
      create: { width: 1024, height: 500, channels: 4, background: { r: 11, g: 13, b: 18, alpha: 1 } }
    }).composite([{ input: featureIcon, gravity: 'centre' }]).png().toFile(path.join(t, 'feature-graphic.png'));
  }
  console.log('feature-graphic.png (1024x500)');
}

generate()
  .then(() => console.log('\nDone! Files in brand-kit/ and assets/'))
  .catch(e => { console.error(e); process.exit(1); });
