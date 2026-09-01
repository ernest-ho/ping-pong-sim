# Arc Lab

An interactive 3D table-tennis collision simulator built with Bun, React, Three.js, and Tailwind CSS.

## Run locally

```bash
bun install
bun run dev
```

Open the local URL printed by Vite. Use `bun run build` for a production build.
Run `bun test` to check the fixed-contact and material-response invariants.

## Share over Tailscale

With the development server running on port 5173, expose it privately to your tailnet:

```bash
tailscale serve --bg http://127.0.0.1:5173
```

Run `tailscale serve status` to see its HTTPS URL, and `tailscale serve reset` to remove the route.

## Simulation model

- The regulation table stays centered at the scene origin, with its legs on the floor and playing surface at 0.76 m.
- The top-down picker selects a ball-start point within the racket-side half, exactly one physical radius above the surface.
- Initial side and vertical angles define the ball's launch direction from that point.
- A 0%–100% flight-phase control selects where the racket meets the ball: launch is 0%, the calculated apex is fixed at 50%, and first floor contact is 100%.
- The sidebar overlays a grey no-hit continuation for comparison.
- The incoming path includes drag, gravity, spin decay, and Magnus force, and determines the racket contact location rather than targeting a fixed world point.
- Reset restores the 80% X / 50% Y ball-start position.
- Incoming ball and racket trajectories meet at the calculated contact point.
- Racket motion supports signed acceleration and independent Linear and Circular setups. Linear mode uses an impact close-up with live ball spin. Circular mode defines the circle with radius, top-down clockwise/counterclockwise travel, a clock-style reference tangent (front side 12, right 3, back 6), and a separate millisecond contact-time control that advances the actual contact point around the circle using racket speed, acceleration, and radius. Left/right tilt acts around the 12–6 axis and lift around the 3–9 axis; the circle center is solved on the selected turning side and explicitly labeled in the preview. Its dynamically framed visualizer includes the regulation table and matching floor grid for orientation. Every racket and ball preview, the ball-start picker, and the flight-contact diagram mirror the current main-camera POV; ball rotation follows simulated angular speed and time, and swing paths use one purple dashed line. For circular paths, Hook controls the in-plane angle from the tangent; linear paths have no swing plane of their own, so the same control is presented as Face yaw, a left/right turn of the face around vertical independent of the path's elevation. Face tilt independently moves the face out of that plane in both modes.
- A time-resolved normal contact uses nonlinear ball, sponge, and blade compliance.
- Sponge thickness and hardness control deformation, dwell, and progressive bottom-out.
- Blade flexural stiffness and damping alter the force pulse and vibration energy loss.
- Rubber shear is stored and released during dwell, capped by Coulomb friction, and changes all three components of ball spin.
- Flight after contact integrates gravity, quadratic drag, spin decay, and 3D Magnus acceleration.
- Ball-table intersections use the table bounds, normal restitution, adjustable surface friction, and spin transfer.
- The racket is treated as an infinite-mass moving surface; the ball is a 2.7 g hollow sphere.
- Playback supports frame stepping, drag scrubbing, and 0.05× to 1× slow motion.
- Both telemetry panels collapse independently, and the complete interface supports dark mode.

The ball is rendered larger than physical scale to keep its spin markings visible. Physics calculations still use the regulation 20 mm radius.
