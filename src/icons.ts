// Material Symbols (rounded, weight 400), inlined as SVG so they work offline.
import menu from '@material-symbols/svg-400/rounded/menu.svg?raw';
import waterDrop from '@material-symbols/svg-400/rounded/water_drop.svg?raw';
import waterDropFill from '@material-symbols/svg-400/rounded/water_drop-fill.svg?raw';
import glassCup from '@material-symbols/svg-400/rounded/glass_cup.svg?raw';
import glassCupFill from '@material-symbols/svg-400/rounded/glass_cup-fill.svg?raw';
import swipe from '@material-symbols/svg-400/rounded/swipe.svg?raw';
import swipeFill from '@material-symbols/svg-400/rounded/swipe-fill.svg?raw';
import rotation from '@material-symbols/svg-400/rounded/3d_rotation.svg?raw';
import rotationFill from '@material-symbols/svg-400/rounded/3d_rotation-fill.svg?raw';
import upload from '@material-symbols/svg-400/rounded/upload.svg?raw';
import fire from '@material-symbols/svg-400/rounded/local_fire_department.svg?raw';
import fireFill from '@material-symbols/svg-400/rounded/local_fire_department-fill.svg?raw';
import palette from '@material-symbols/svg-400/rounded/palette.svg?raw';

const ICONS: Record<string, [string, string?]> = {
  menu: [menu],
  water_drop: [waterDrop, waterDropFill],
  glass_cup: [glassCup, glassCupFill],
  swipe: [swipe, swipeFill],
  '3d_rotation': [rotation, rotationFill],
  upload: [upload],
  local_fire_department: [fire, fireFill],
  palette: [palette],
};

const clean = (svg: string, cls: string) => svg.replace(/ width="\d+" height="\d+"/, '').replace('<svg ', `<svg class="${cls}" aria-hidden="true" `);

/** Fills every `<span class="icon" data-icon="…">`. With `data-fill`, the filled variant shows when active. */
export function mountIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('.icon[data-icon]').forEach(el => {
    const [o, f] = ICONS[el.dataset.icon!] ?? [];
    if (!o) throw new Error('unknown icon ' + el.dataset.icon);
    el.innerHTML = clean(o, 'o') + (f && el.hasAttribute('data-fill') ? clean(f, 'f') : '');
  });
}
