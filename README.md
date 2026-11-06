# Pour

Acrylic open cup pour simulator for phones – pour.gnass.buzz.
WebGL 2 thin-film simulation (based on `webgl-experiments/experiment6`), installable as a PWA.

## Develop

```sh
npm install
npm run dev         # http://localhost:5173
npm run dev:https   # self-signed HTTPS on the LAN: device motion needs a secure context
npm run build       # static site in dist/
```

URL options: `?n=200` thickness cells per short side, `?np=512` pigment texels per short side.

## How it works

- **Tilt** comes from `deviceorientation`, relative to the pose at Start (or after "Level").
  Without a sensor the app shows a Tilt tool and tilts the canvas on screen (arrow keys on desktop).
- **Pour**: hold a finger on the canvas to pour the selected paint. On the cup it goes into the cup;
  colours sink below the white.
- **Cup**: tap to set it down. While it sits on the canvas, the Cup button is Lift. Hold on the cup to pour
  into it, drag from the cup to move it.
- **Swipe** pushes wet paint, **Torch** makes more cells pop up.

Code: `src/sim/` (GL, shaders, solver), `src/model.ts` (cup, sources, cells), `src/tilt.ts`,
`src/demo.ts`, `src/main.ts` (UI and gestures).
