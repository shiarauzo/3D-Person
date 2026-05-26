# 3D Person

An interactive 3D character scene built with **Next.js** + **React Three Fiber**.

A stylized low-poly humanoid — assembled entirely from primitives — with a subtle
idle animation (breathing, weight shift, head turn), real-time shadows, and orbit
controls.

## Stack

- [Next.js 15](https://nextjs.org/) (App Router)
- [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) — React renderer for three.js
- [drei](https://github.com/pmndrs/drei) — helpers (OrbitControls, Environment, ContactShadows)
- [three.js](https://threejs.org/)
- TypeScript

## Getting started

```bash
bun install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000). Drag to orbit, scroll to zoom.

## Project layout

```
app/
├── layout.tsx      # Root layout + metadata
├── globals.css     # Base styles + overlay
└── page.tsx        # Loads the (client-only) 3D scene

components/
├── scene.tsx       # Canvas, lighting, ground, camera, controls
└── person.tsx      # The animated humanoid built from primitives
```

## Where to go next

- Swap the primitive figure for a real model: drop a `.glb` into `public/` and load
  it with `useGLTF` from drei.
- Add skeletal animations with `useAnimations`.
- Tweak materials, lighting, and the `useFrame` idle loop in `components/person.tsx`.
