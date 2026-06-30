Cheaters Bedrock Addon + Companion (OpenAI + ElevenLabs)
=======================================================

What this is
- A Bedrock behavior pack + resource pack (CheatersBP + CheatersRP) that defines a "cheater" NPC entity.
- Cheaters automatically spawn and wander in your world when you load it.
- A companion Node.js server that tails your BDS log, calls OpenAI for replies and ElevenLabs for TTS, updates the resource pack with generated audio, serves it for players to download, and uses RCON to run tellraw/playsound commands.

Quick prerequisites
- Bedrock Dedicated Server (BDS) on same host (recommended) or access to its logs and RCON.
- Node.js 18+ on the companion host.
- OpenAI API key and ElevenLabs API key.
- Players must download the resource pack served by the companion to hear TTS audio.

Quick build & run
1. Clone this repo: git clone https://github.com/kodie230/garden-of-banban.git
2. Copy companion/config.example.json -> companion/config.json and set paths & API keys.
3. Make build script executable: chmod +x build_mcpack.sh
4. Run: ./build_mcpack.sh
   - Output: dist/CheatersAddon.mcpack and dist/cheaters_companion.zip
5. Import CheatersAddon.mcpack into your Bedrock world / BDS or copy behavior_packs/ & resource_packs/ into the BDS world folder.
6. Unzip and run companion: cd companion && npm install && node server.js

Notes
- Cheaters automatically spawn and wander when you load the world (no /summon needed).
- Edit behavior_packs/CheatersBP/functions/spawn_cheaters.mcfunction to customize spawn locations/count.
- Tune companion/config.json regexes to match your BDS log format if necessary.
- For iOS: Clone on Mac/Windows, run build script, then transfer the .mcpack to iOS via iCloud Drive or email.

Security & licensing
- Replace copyrighted assets before distribution.
- LLM/TTS calls cost money — use rate limiting/caching for production.
