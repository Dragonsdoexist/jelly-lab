# Jelly Lab

[Play Jelly Lab](https://dragonsdoexist.github.io/jelly-lab/)

An interactive 3D playground with 24 translucent AI company logos. Lift a logo by a corner, drop it onto another, and turn the softness dial to change how the stack compresses. Mouse and touch controls work in the same scene.

Drag the empty floor to orbit the studio. **Reset view** returns the camera to its starting angle and keeps your jelly arrangement in place.

On a phone, hold it at a comfortable angle and turn on **Phone motion**. Allow motion access if asked. Lower an edge to slide the jelly, or scoop forward and up, then draw back to toss it like a wok (颠勺). Switch motion off to level the tray. Turning it back on sets a new neutral angle.

To run locally, use `python3 -m http.server 8000` from this directory and open `http://localhost:8000/`. The models, fonts, and rendering and physics libraries are included.

Third-party credits and licenses are included in `marks/`, `fonts/`, and `vendor/`.
