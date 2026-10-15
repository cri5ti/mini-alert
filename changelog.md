# Changelog

## Current

- The lobby is a command console: a MINI ALERT header with your name, Copy my link and a Live light, steel panels with stencil headings, faint scanlines and a light running along the panel edges; nothing moves when your system asks for reduced motion. Games are battles, listed as #N with Open, Staging or In combat, and Deploy starts one. On phones the panels stack in one column.
- Dragging the AI pace slider in a game room no longer lets go after one step.
- Feature requests on the main screen: post a short request in the Requests panel and vote for the ones you want with ▲; click again to take your vote back. The most voted are listed first and finished requests move to Done. Each player can have three open requests at a time.
- The map preview is a radar: a glowing square frame with range rings, a crosshair and a turning sweep that goes amber while the map draws. In the waiting room a radar scope above Requests shows every battle as a blip in the colour of its state; phones leave it out.
- On a phone the waiting room and game rooms scroll, and each panel shows all of its content instead of being squeezed into one screen and overlapping the next.
- Units brushing past city buildings no longer twitch: your game stops them at a building's edge, as the server does.
- Units stay exactly where they belong between server updates: a correction eases in only what it changes instead of knocking the unit up to a step off its glide.
- A late network packet no longer leaves units drifting on screen: your game replays every unit from the packet's moment, not only the units it corrects.
- Units no longer slowly slide away from where the server has them: the server checks your view against exactly the positions your game receives.
- Redirecting units already on the move no longer makes them jump back: they keep their course until the server answers, then take the new route from where they are.
- Enemy units in a crowd no longer twitch on your screen: when two units reach the same spot at once, your game lets the same one through as the server.
- About a third less traffic in battles: scouts and jets, which aim with their whole body, turn toward their target on your screen as on the server, so they are no longer resent every time they turn.
- AI opponents train an army again once their factory is up, instead of sitting on their credits.
- A unit force-attacking one of your own, and a jet with rockets left after losing its airport, stop and turn toward the target on your screen as on the server, instead of being corrected.
- Ammo counts go only to the unit's owner, except a rocket unit running empty or rearming, halving the extra unit updates ammo counts add in battle.
- With TRACE=1 the server log shows, once a minute beside the tick rate, the average milliseconds per tick each server system takes, largest first, and how much of the tick stays idle. The deployed server runs with TRACE=1. The in-game timing pie shows only for admins.
- Coming under attack sounds an alarm with the minimap blip: at random, either a dancehall air horn or a Jamaican voice calling "Wi base a get attack!" when a building or city is hit or "Unit a get lick!" when a unit is, each drawn from several recorded takes. Settings › Sounds turns it off, cutting short an alarm already sounding, and remembers the choice.
- The minimap attack ping is hard to miss: a large ring closes on the spot, the spot pulses three times under a bright marker and the minimap edge flashes once, red when a building or city is hit and amber when a unit is. It lasts about 4 seconds; when your system asks for reduced motion it is a still ring and marker.
- A third battle track, Vroom Vroom Tancul, joins the music shuffled through a match.
- Settings has a Music volume and a Sounds volume slider, from 0 to 100% in steps of 5, each under its On/Off switch. They work by touch and with the arrow keys, apply as you move them and are remembered. Music starts at 40% and sounds at 100%.
- The Music volume slider sets the music level on iPhone and iPad too.
- On the minimap every enemy unit and building keeps its owner's colour inside a red outline, so enemies stand out from your own dots. While spectating, the enemies are those of the faction you view.
- The battle screen is a command console like the lobby. A top bar shows the MINI ALERT mark, the battle number, Credits (▲ while rising, ▼ while falling), Units as army / population, Pop, Cities and the ◉ ping, with Menu and Help (?) at the right; the Menu holds the Music, Sounds and Input settings, Changelog, Full screen and Surrender. A 300 px sidebar frames the minimap as 01 Radar and the build tiles as 02 Build; spectators get 02 Vision, a plate per faction and Leave. The map fills the space beside them, the legend and the admin timing pie sit at its top corners, and Help, the changelog, Victory and Defeated open as console dialogs; an unseen changelog now shows over the lobby too. On phones the bar spans the top and the sidebar is a 120 px rail whose every control is at least 44 px.
- The Build panel has Base, Land, Air and Sea tabs. Selecting a factory opens Land, an airport or helipad Air and a shipyard Sea, and any other selection brings back Base; a tab you pick stays open until the selection changes, so a structure can be placed while a factory is selected. Every tile of the open tab shows, with its price, a state line (Ready · place, its build percentage, or why it cannot be used, such as Needs a factory, Select an airport or Needs population), a progress bar along its bottom and its F-key; F1 onward press the tiles of the open tab. The Queue line at the bottom of the panel has a chip for each type in production at every building, and clicking one drops the latest order of that type.
- A Selected panel at the bottom left of the map lists your selection: a row per unit type with its count and a health bar in green, amber or red, a building still going up with its percentage, and Group N when the selection is a control group. A selected city hall shows its focus slider there, and the Build panel stays open on Base, so F1 onward press its tiles. Clicks on the panel go through to the map, except on the slider; on phones its rows sit as small chips.
- Back in the lobby after a match, the F-keys do what your browser does with them again, so F5 reloads the page. The next match no longer opens with the last match's numbers in the top bar, its selection in the Selected panel, its map on the radar or the Menu still open.

## 0.6
- F1 onward queues the build and train tiles. The key sits in the bottom-right of each tile.
- Improved cities, growth, density, growth / income control
- Unit rebalance
- Force attack own units
- Map generation options
- Minimap blips
- Per factory queues
- Air atttack now doesn't damage land units / structures.
- Jets: reduced speed and health.
- Turrets: improved targetting and fire rate. Health is tripled, to 300.
- Cruisers turn faster and shoot farther.
- Improved AI.

## 0.5 (Swipelab)

- Selection works like Red Alert: Shift+click adds or removes a unit, Shift+drag adds a box, right-click deselects, double-click or double-tap selects every unit of that type on screen.
- Control groups: Ctrl+1–9 (or Alt+1–9) assigns, 1–9 selects, press twice to center the camera, Shift+number adds the group.
- Minimap: click jumps the camera, drag pans, right-click sends the selected units.
- Order units into the fog. A group spreads around the target; water, forest, or a walled-in spot sends them to the nearest tile they can reach.
- Middle-click panning lets go when you release the button.
- Smoother play online. Orders start at once, units keep a steady speed, and turrets turn as they acquire a target.
- Scouting, capturing, and long battles no longer stutter, even as cities get torn up.
- If the game falls behind, it slows down instead of leaving holes in the map.
- The HUD shows your ping.
- Queued units, rally flags, the primary factory, and new building sites show the moment you click.
- Reloading, or a connection that drops (a phone switching networks, a backgrounded tab), keeps your seat.
- One seat per browser. Opening another tab moves you there; the old tab can take the seat back. Copy my link in the lobby to play as yourself on another device.
- Anyone gone from an unstarted game for ten minutes leaves it, and an empty game closes. Started matches keep their seats.

## 0.4
- New structures: Airports, helipads, shipyards, 
- New units: jets, gunship, cruisers
- Fight on water, air, land.
- Credits cap at 10,000 plus 500 per population. Losing population throws away anything above the new cap.
- Structures require population
- Unit rebalancing
- Phones get a narrow order bar. Two fingers pan and pinch the map; the page itself does not zoom
- Nicer shroud / fog of war edges

## 0.3

- Cities and trees can be destroyed. 
- Armies require populations to sustain and build.
- Improved unit steering & pathing in narow paths
- Reduce artilery range
- Increased tank armours

## 0.2

- Conquer cities and hold them to earn credits. Leave units in a city and it grows.
- Improved fog of war.
- Construction spends credits while the work is underway, not when you queue it.
- Turn the camera with Q and E.
- Forests are denser.

## 0.1

- Island skirmish with selection, move, and attack orders.
- Pan, rotate, and zoom the camera.
