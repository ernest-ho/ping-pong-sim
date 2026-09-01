# Arc Lab

Arc Lab is an interactive 3D table-tennis stroke and collision simulator built with Bun, React, React Three Fiber, Three.js, and Tailwind CSS.

It combines editable launch and racket controls with a time-resolved ball/rubber/blade contact model, camera-relative swing visualizers, full-flight playback, and impact telemetry.

[Open the GitHub Pages build](https://ernest-ho.github.io/ping-pong-sim/)

## Features

### Ball and flight

- Select the ball start precisely as table-relative X and Y percentages. The default is 80% X and 50% Y.
- Set launch speed, side angle, vertical angle, and three independent spin components.
- Drag the contact point along the unhit flight or enter its percentage directly. Launch, calculated apex, and first floor contact map to 0%, 50%, and 100%.
- Compare the simulated stroke with a grey no-hit continuation.
- Integrate gravity, quadratic drag, spin decay, and 3D Magnus acceleration before and after racket contact.
- Resolve regulation-table, tabletop-body, edge, net, floor, and ball-table collisions.

### Racket motion

- Set impact speed and signed pre-contact acceleration.
- Apply independent after-contact deceleration without reversing the racket when it reaches zero speed.
- Choose linear or circular swing paths.
- Linear paths expose side and lift angles and use a close-up version of the active scene camera.
- Circular paths expose radius, top-view CW/CCW winding, contact tangent, timed contact offset, side tilt, and lift.
- The optional CW/CCW conversion mode preserves the current contact geometry when changing winding. It is enabled by default and can be disabled for raw winding changes.
- Circular handles point toward the solved circle center unless face controls intentionally break that relationship.
- Face yaw/hook and face tilt independently orient the racket relative to the path tangent.
- All angle controls accept decimal values.

### Material and impact model

- The regulation 2.7 g, 20 mm-radius hollow ball is integrated against a compliant rubber contact patch.
- Normal rebound is calibrated against measured impact-speed and blade-flexural-rigidity trends instead of using a user-selected restitution value.
- Sponge thickness, nominal hardness, and loss factor control deformation, dwell, dissipation, and progressive densification.
- Practical sponge bottom-out occurs at 65% compression, with nonlinear hardening beginning before densification.
- Topsheet pre-strain contributes normal membrane stiffness and tangential shear stiffness.
- Topsheet and sponge loss are represented as viscoelastic loss factors, `tan δ`.
- Grip/slip contact stores and returns tangential shear energy while enforcing an effective Coulomb-friction limit.
- Booster treatment is an explicitly empirical coupled adjustment: it expands and softens the sponge, increases estimated topsheet pre-strain, and reduces loss.
- Blade flexural rigidity, assembled racket mass, and modal damping drive a damped first bending mode during contact.
- The material panel reports dwell, force, restitution, sponge travel, bottom-out, loaded blade frequency, and blade deflection.

### Visualization and telemetry

- Free, side, front, top, and ball-following camera presets share the current camera orientation with the ball, linear-path, and circular-path previews.
- Circular previews include the table, floor grid, clock directions, circle center, racket, and dynamically fitted path.
- Racket swing paths use a single purple dotted trajectory.
- Ball markings rotate at simulated angular speed and respect playback speed.
- Playback supports scrubbing, keyboard frame stepping, 0.05×–1× slow motion, and automatically resets to the beginning when it finishes.
- Live and impact panels show speed, total spin, roll, sidespin, and top/backspin with camera-relative direction labels.
- Elite stroke references distinguish resultant racket speed/acceleration from post-impact ball speed/spin.
- Slider values are directly editable, and the interface supports dark mode.

## Default setup

| Parameter | Default |
| --- | ---: |
| Ball speed | 10 km/h |
| Ball vertical angle | 45° |
| Initial top/back spin | −1,700 rpm |
| Contact point in flight | 55% |
| Racket speed | 80 km/h |
| Path lift | 60° |
| Face tilt | −80° |
| Topsheet pre-strain | 1% |
| Sponge | 2.0 mm, 45° nominal hardness |
| Blade flexural rigidity | 2.6 N·m² |
| Assembled racket mass | 170 g |

## Scientific basis

Arc Lab is a reduced-order interactive model, not a product-certification tool. Its material behavior is informed by:

- Karasawa et al., *Evaluation of restitution performance and examination of estimate equation of coefficient of restitution of table tennis racket* — impact-speed and flexural-rigidity calibration. [DOI](https://doi.org/10.1299/transjsme.21-00145)
- Rinaldi et al., *Non Linearity of the Ball/Rubber Impact in Table Tennis* — speed-dependent restitution, ball buckling, polymer rate dependence, and frictional loss. [DOI](https://doi.org/10.1016/j.proeng.2016.06.307)
- Rinaldi et al., *Table Tennis Ball Impacting Racket Polymeric Coatings* — oblique impacts, spin, rubber architecture, and contact friction. [DOI](https://doi.org/10.3390/app9010158)
- Kawazoe and Suzuki, *Impact prediction between a ball and racket* — nonlinear ball/rubber stiffness, contact time, reduced racket mass, and racket vibration. [Paper](https://kawazoe-lab.com/wp-content/uploads/2016/08/20040015.pdf)
- Cross, *Impact of a ball on a surface with tangential compliance* — grip/slip transitions and elastic tangential energy return. [DOI](https://doi.org/10.1119/1.3313455)

Exact commercial-rubber prediction would require product-specific dynamic mechanical analysis, large-strain compression data, pimple geometry, friction as a function of load and sliding speed, temperature, and measured blade mode shapes. Booster response is especially rubber- and treatment-specific; post-factory treatment is not competition-legal.

## Run locally

Requires [Bun](https://bun.sh/).

```bash
bun install
bun run dev
```

Open the URL printed by Vite.

```bash
bun test
bun run build
bun run preview
```

- `bun test` runs the physics, geometry, material-sensitivity, and calibration suite.
- `bun run build` type-checks the project and creates the production bundle in `dist/`.
- `bun run preview` serves the production bundle locally.

## Deployment

Pushes to `main` run the GitHub Actions workflow in `.github/workflows/deploy.yml`. It installs dependencies, runs the full test suite, builds the app, and deploys `dist/` to GitHub Pages.

## Rendering note

The displayed ball is intentionally larger than physical scale so its spin markings remain visible. All physics calculations use the regulation 20 mm ball radius.
