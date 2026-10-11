--@name Dynamic crosshair
--@version 1.0
--@author HvH
--@desc Draws a crosshair whose gap widens while you move, using only the draw API.
--@requires 3.4

ui.slider("size", "Arm length", 2, 16, 6)
ui.slider("gap", "Base gap", 0, 12, 3)
ui.combo("col", "Colour", {"#9fca2b", "#4fd1ff", "#ffffff", "#ff5a5a"}, "#9fca2b")

hvh.on("draw", function(w, h)
  local p = hvh.player()
  local gap = ui.get("gap") + math.min(12, (p.speed or 0) * 0.9)
  local s, c = ui.get("size"), ui.get("col")
  local cx, cy = w / 2, h / 2
  draw.line(cx - gap - s, cy, cx - gap, cy, c, 2)
  draw.line(cx + gap, cy, cx + gap + s, cy, c, 2)
  draw.line(cx, cy - gap - s, cx, cy - gap, c, 2)
  draw.line(cx, cy + gap, cx, cy + gap + s, c, 2)
end)
