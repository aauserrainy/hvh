--@name Hit counter
--@version 1.0
--@author HvH
--@desc Counts confirmed hits and headshots, shows them on screen, plays a sound on every 5th headshot.
--@requires 3.4

local show   = ui.checkbox("show", "Show counter", true)
local milestone = ui.slider("every", "Headshot milestone", 2, 20, 5)
local snd    = ui.combo("snd", "Milestone sound", {"Bell", "Skeet", "Double tick", "Pop"}, "Bell")

local hits, heads = 0, 0

hvh.on("hit", function(e)
  hits = hits + 1
  if e.head then
    heads = heads + 1
    if heads % ui.get("every") == 0 then
      hvh.notify("Streak", heads .. " headshots", "#ffd23f")
      hvh.sound(ui.get("snd"), 0.5)
    end
  end
end)

hvh.on("round_start", function() hits, heads = 0, 0 end)

hvh.on("draw", function(w, h)
  if not ui.get("show") then return end
  draw.rect(w - 190, h - 90, 170, 48, "rgba(10,10,12,0.75)")
  draw.text(w - 180, h - 70, "Hits " .. hits, "#d6d9de", 13)
  draw.text(w - 180, h - 52, "Headshots " .. heads .. (hits > 0 and ("  (" .. math.floor(heads * 100 / hits) .. "%)") or ""), "#9fca2b", 13)
end)

hvh.log("hit counter ready")
