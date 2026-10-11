--@name Bot anti-aim cycler
--@version 1.0
--@author HvH
--@desc Cycles the bots' anti-aim profile on a timer. Press F8 to pause or resume.
--@requires 3.4

ui.slider("secs", "Seconds per profile", 2, 30, 8)
ui.checkbox("note", "Notify on change", true)

local profiles = {"Spin", "Jitter", "Static", "Down", "Crouch"}
local idx, last, paused = 0, hvh.time(), false

hvh.key("F8", function()
  paused = not paused
  hvh.notify("AA cycler", paused and "paused" or "running", "#4fd1ff")
end)

hvh.on("tick", function(dt)
  if paused then return end
  if hvh.time() - last >= ui.get("secs") then
    last = hvh.time()
    idx = idx % #profiles + 1
    hvh.set("baa_prof", profiles[idx])
    if ui.get("note") then hvh.notify("Bot AA", profiles[idx], "#4fd1ff") end
  end
end)

hvh.on("draw", function(w, h)
  draw.text(w / 2, 40, "bot aa: " .. (paused and "paused" or profiles[idx] or "-"), "#4fd1ff", 12, "center")
end)
