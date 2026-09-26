"""
generate-skills.py — Deterministic skill generator for World of Astral.

Generates:
  data/skills.json      — 900 skills (100 per class × 9 classes)
  data/skill-tiers.json — tier config reference
  data/levels.json      — levelCap:100 + full xpTable (updated)

Run: python3 scripts/generate-skills.py
"""

import json, math, random, os

# ── Config ────────────────────────────────────────────────────────────
CLASSES = {
    "warrior":   {"school": "PHY", "stat": "str"},
    "mage":      {"school": "MAG", "stat": "int"},
    "rogue":     {"school": "PHY", "stat": "agi"},
    "cleric":    {"school": "MAG", "stat": "int", "healer": True},
    "samurai":   {"school": "PHY", "stat": "str"},
    "knight":    {"school": "PHY", "stat": "str"},
    "duelist":   {"school": "PHY", "stat": "agi"},
    "berserker": {"school": "PHY", "stat": "str"},
    "assassin":  {"school": "PHY", "stat": "agi"},
}

TIERS = [
    {"id": "common",    "mult": 1.0,  "count": 26, "emoji": "⚪"},
    {"id": "uncommon",  "mult": 1.4,  "count": 29, "emoji": "🟢"},
    {"id": "rare",      "mult": 1.9,  "count": 20, "emoji": "🔵"},
    {"id": "epic",      "mult": 2.4,  "count": 15, "emoji": "🟣"},
    {"id": "legendary", "mult": 3.0,  "count": 10, "emoji": "🟡"},
]

# Unlock gates per tier (14 gates total, 100 skills per class)
GATES = [1,5,10,15,20,25,30,40,50,60,70,80,90,100]

# Secondary status effect pools per school
PHY_EFFECTS = ["stun", "weaken", "blind", "bleed", "slow"]
MAG_EFFECTS = ["burn", "poison", "freeze", "weaken", "blind"]

# ── Word banks ────────────────────────────────────────────────────────
WORDS = {
    "warrior": {
        "adj":  ["Iron", "Steel", "Raging", "Mighty", "Battle", "War", "Relentless", "Crushing",
                 "Bereft", "Thundering", "Stalwart", "Unyielding", "Savage", "Ancient", "Blood"],
        "noun": ["Slash", "Strike", "Charge", "Cleave", "Roar", "Stance", "Smash", "Guard",
                 "Fury", "Blade", "Rampage", "Resolve", "Warcry", "Bastion", "Edge"],
        "rare": ["Iron Rampage", "Warlord's Fury", "Blood Tide", "Titan's Fall",
                 "Ruin Breaker", "Warborn Edge", "Ironclad Wrath", "Battleborn Surge",
                 "Crimson Tide", "The Last Stand", "Oblivion Cleave", "Undying Wrath",
                 "Siege Breaker", "Warden's Wrath", "Executioner's Mark",
                 "Vanguard's Fury", "Eternal Rampage", "Iron God Fist",
                 "Last Warrior", "Supreme Cleave"],
    },
    "mage": {
        "adj":  ["Arcane", "Blazing", "Frozen", "Storm", "Void", "Ethereal", "Astral", "Prismatic",
                 "Dark", "Radiant", "Arcane", "Ancient", "Frostbound", "Ember", "Tempest"],
        "noun": ["Bolt", "Burst", "Ray", "Nova", "Seal", "Vortex", "Wave", "Pulse",
                 "Flame", "Glyph", "Torrent", "Cascade", "Rune", "Blast", "Surge"],
        "rare": ["Arcane Collapse", "Void Ignition", "Frostfire Nova", "Storm Convergence",
                 "Eternal Flame", "Dark Singularity", "The Unravelling", "Prismatic Detonation",
                 "Celestial Ray", "Void Surge", "Infernal Cascade", "Frozen Eternity",
                 "Astral Collapse", "Mana Rupture", "Reality Break",
                 "Grand Torrent", "Omega Nova", "Starfall Cascade",
                 "Oblivion Ray", "The Final Word"],
    },
    "rogue": {
        "adj":  ["Shadow", "Swift", "Venomous", "Deadly", "Silent", "Crimson", "Dark", "Cunning",
                 "Phantom", "Lurking", "Hidden", "Evasive", "Sharp", "Fleeting", "Marked"],
        "noun": ["Strike", "Stab", "Vanish", "Poison", "Dash", "Gambit", "Cut", "Mark",
                 "Fade", "Snap", "Blur", "Flicker", "Fang", "Shroud", "Step"],
        "rare": ["Shadow Execution", "Phantom Fang", "Death by a Thousand Cuts", "Venom Shroud",
                 "The Last Shadow", "Crimson Blur", "Ghost Strike", "Silent Reaper",
                 "Mark of Death", "Vanishing Act", "Dark Execution", "Serpent Strike",
                 "Void Blur", "Perfect Murder", "The Unseen",
                 "Blade of Silence", "Shadow Sovereign", "Echoing Void",
                 "Shatterpoint", "The Final Fade"],
    },
    "cleric": {
        "adj":  ["Holy", "Divine", "Blessed", "Sacred", "Radiant", "Celestial", "Healing", "Pure",
                 "Golden", "Ancient", "Eternal", "Gentle", "Faithful", "Astral", "Shining"],
        "noun": ["Light", "Blessing", "Mending", "Prayer", "Seal", "Grace", "Ward", "Hymn",
                 "Aura", "Vow", "Tide", "Miracle", "Remedy", "Relic", "Invocation"],
        "rare": ["Divine Intervention", "Sacred Rebirth", "Holy Convergence", "Celestial Ward",
                 "Eternal Hymn", "Astral Mending", "Blessing of the Eternal", "Radiant Miracle",
                 "Heaven's Tide", "The Last Prayer", "Godlight Wave", "Soul Restoration",
                 "Divine Cascade", "Sacred Vow", "Astral Grace",
                 "Light Eternal", "Holy Arbiter", "Heaven's Final Word",
                 "Pure Deliverance", "The Eternal Blessing"],
    },
    "samurai": {
        "adj":  ["Swift", "Honour", "Steel", "Wind", "Iron", "Void", "Shadow", "Sacred",
                 "Ancient", "Blade", "Storm", "Crimson", "Silent", "Fading", "Unsheathed"],
        "noun": ["Cut", "Draw", "Stance", "Strike", "Slash", "Breath", "Edge", "Step",
                 "Form", "Art", "Way", "Seal", "Dance", "Gale", "Path"],
        "rare": ["Iaido Flash", "Bushido's Edge", "One Cut Wonder", "Wind Blade Mastery",
                 "Void Katana", "The Last Draw", "Crimson Petal Strike", "Honour Cleave",
                 "Steel Blossom", "Death Draw", "The Thousand Cuts", "Ancient Blade Art",
                 "Empty Mind Strike", "Perfect Form", "Muramasa's Echo",
                 "Battou Flash", "Kensai's Will", "Eternal Kata",
                 "Soul Slash", "Heaven Cutter"],
    },
    "knight": {
        "adj":  ["Stalwart", "Ironclad", "Holy", "Crusading", "Shield", "Bastion", "Valiant",
                 "Eternal", "Sacred", "Tempered", "Blessed", "Unyielding", "Radiant",
                 "Fortress", "Divine"],
        "noun": ["Bash", "Guard", "Charge", "Vow", "Seal", "Challenge", "Wall", "Bulwark",
                 "Smite", "Oath", "Warden", "Ward", "Crest", "Wrath", "Aegis"],
        "rare": ["Crusader's Vow", "Iron Bulwark", "Holy Retribution", "Fortress Charge",
                 "Bastion Break", "Divine Warden", "Shield of the Eternal", "Sacred Oath",
                 "Radiant Bulwark", "The Last Bastion", "Heaven's Warden", "Iron Crusade",
                 "Unyielding Will", "Holy Aegis", "Fortress God",
                 "The Unbreakable", "Divine Retribution", "Bastion Eternal",
                 "Iron Saint", "Final Crusade"],
    },
    "duelist": {
        "adj":  ["Swift", "Precise", "Graceful", "Counter", "Keen", "Perfect", "Fleeting",
                 "Sharp", "Blinding", "Dancing", "Mirror", "Evasive", "Cruel", "Elegant", "True"],
        "noun": ["Strike", "Riposte", "Parry", "Thrust", "Lunge", "Step", "Feint",
                 "Flourish", "Counter", "Flash", "Edge", "Blitz", "Dance", "Point", "Draw"],
        "rare": ["Perfect Riposte", "Blinding Flourish", "Counter's Grace", "Blade Dance",
                 "Evasive Execution", "Mirror Thrust", "The Graceful Kill", "Cruel Precision",
                 "Swift Justice", "The Final Lunge", "Dancing Blade", "Fencer's Will",
                 "Killing Tempo", "Perfect Duel", "The Unmatched",
                 "Blade of Grace", "Endless Counter", "True Strike Mastery",
                 "Dancing Execution", "The Last Flourish"],
    },
    "berserker": {
        "adj":  ["Raging", "Savage", "Brutal", "Wild", "Fury", "Bereft", "Frenzied", "Blood",
                 "Manic", "Primal", "Rabid", "Unhinged", "Vicious", "Torn", "Mad"],
        "noun": ["Swing", "Smash", "Roar", "Frenzy", "Rush", "Crush", "Rampage", "Shatter",
                 "Howl", "Charge", "Break", "Cleave", "Onslaught", "Tide", "Burst"],
        "rare": ["Blood Frenzy", "Savage Rampage", "Primal Roar", "Berserker's Will",
                 "Wild Onslaught", "Mad God's Charge", "Fury Incarnate", "The Last Frenzy",
                 "Unhinged Cleave", "Tidal Rage", "Brutal Convergence", "Savage Execution",
                 "God's Fury", "The Manic Rush", "Primal God",
                 "Eternal Rage", "Frenzy God", "Berserk Absolute",
                 "Primal Absolute", "The Mad One"],
    },
    "assassin": {
        "adj":  ["Shadow", "Venom", "Silent", "Phantom", "Dark", "Lethal", "Perfect",
                 "Void", "Mark", "Cursed", "Swift", "Evasive", "Hidden", "Poison", "Death"],
        "noun": ["Strike", "Mark", "Veil", "Step", "Execution", "Toxin", "Fade", "Hunt",
                 "Slash", "Brand", "Shroud", "Art", "Seal", "Snare", "End"],
        "rare": ["Perfect Silence", "Phantom Execution", "Venom God", "Death Mark Mastery",
                 "Shadow Sovereign", "The Silent Kill", "Void Assassination", "Cursed Brand",
                 "Dark Execution", "The Last Target", "Lethal Shadow", "Poison Absolute",
                 "Death's Envoy", "Perfect Murder", "The Unseen Hand",
                 "Void Reaper", "Shadow God", "Eternal Mark",
                 "Oblivion Strike", "The Final Contract"],
    },
}

SECONDARY_CHANCE = 0.30   # 30% uncommon+, 40% rare+, 60% epic+, 80% legendary
SECONDARY_CHANCE_BY_TIER = {"uncommon": 0.30, "rare": 0.40, "epic": 0.60, "legendary": 0.80}

def get_secondary_effect(cls_key, tier_id, rng):
    chance = SECONDARY_CHANCE_BY_TIER.get(tier_id, 0.0)
    if rng.random() >= chance:
        return None
    pool = PHY_EFFECTS if CLASSES[cls_key]["school"] == "PHY" else MAG_EFFECTS
    eff  = rng.choice(pool)
    # effect objects
    if eff == "stun":
        return {"type": "stun", "turns": 1}
    if eff == "weaken":
        return {"type": "weaken", "stat": rng.choice(["str", "agi", "int", "def"]), "pct": round(0.10 + 0.05 * rng.random(), 2)}
    if eff == "blind":
        return {"type": "blind", "turns": rng.randint(1, 2)}
    if eff == "burn":
        return {"type": "burn", "dmgPct": round(0.05 + 0.03 * rng.random(), 2), "turns": rng.randint(2, 3)}
    if eff == "poison":
        return {"type": "poison", "dmgPct": round(0.04 + 0.02 * rng.random(), 2), "turns": rng.randint(2, 4)}
    if eff == "freeze":
        return {"type": "freeze", "turns": 1}
    if eff == "bleed":
        return {"type": "bleed", "dmgPct": round(0.03 + 0.02 * rng.random(), 2), "turns": rng.randint(2, 3)}
    if eff == "slow":
        return {"type": "slow", "turns": rng.randint(1, 2)}
    return None

def build_strengthen_effect(order, rng):
    pct  = round(0.15 + 0.05 * order, 2)
    stat = rng.choice(["str", "agi", "int", "def"])
    return {"type": "strengthen", "stat": stat, "multiplier": pct}

def make_skill(cls_key, tier_id, mult, gate, order, rng, used_names, used_ids, is_passive):
    w     = WORDS[cls_key]
    cls_  = CLASSES[cls_key]
    healer = cls_.get("healer", False)

    # Name — try to stay unique; fallback with numeric suffix
    if tier_id in ("rare", "epic", "legendary"):
        pool = [n for n in w["rare"] if n not in used_names]
        if not pool:
            pool = w["rare"][:]   # allow re-use at rare tier; ID will be suffixed
        name = rng.choice(pool)
    else:
        name = None
        for _ in range(50):
            candidate = f"{rng.choice(w['adj'])} {rng.choice(w['noun'])}"
            if candidate not in used_names:
                name = candidate
                break
        if name is None:
            # Exhausted combinations — use tier+order suffix
            name = f"{rng.choice(w['adj'])} {rng.choice(w['noun'])} {order + 1}"

    used_names.add(name)
    base_id = f"{cls_key}_{name.lower().replace(' ', '_').replace(chr(39), '').replace('-','')}"
    # Guarantee unique ID
    skill_id = base_id
    suffix = 2
    while skill_id in used_ids:
        skill_id = f"{base_id}_{suffix}"
        suffix += 1
    used_ids.add(skill_id)

    if is_passive:
        effects = [build_strengthen_effect(order, rng)]
        return {
            "id": skill_id, "name": name, "classId": cls_key,
            "tier": tier_id, "unlockLevel": gate, "mpCost": 0,
            "type": "passive", "effects": effects,
        }

    # Active skill
    mp_base  = {"common": 8, "uncommon": 14, "rare": 22, "epic": 32, "legendary": 45}[tier_id]
    mp_cost  = mp_base + rng.randint(-2, 4)

    # Cleric heals on roughly 40% of its active skills
    if healer and rng.random() < 0.40:
        heal_mult = round(mult * rng.uniform(0.9, 1.1), 2)
        effects   = [{"type": "heal", "stat": "hp", "multiplier": heal_mult}]
        sec = get_secondary_effect(cls_key, tier_id, rng)
        if sec:
            effects.append(sec)
        return {
            "id": skill_id, "name": name, "classId": cls_key,
            "tier": tier_id, "unlockLevel": gate, "mpCost": mp_cost,
            "type": "active", "effects": effects,
        }

    atk_mult = round(mult * rng.uniform(0.90, 1.10), 2)
    effects  = [{"type": "attack", "stat": cls_["stat"], "multiplier": atk_mult}]
    sec = get_secondary_effect(cls_key, tier_id, rng)
    if sec:
        effects.append(sec)

    return {
        "id": skill_id, "name": name, "classId": cls_key,
        "tier": tier_id, "unlockLevel": gate, "mpCost": mp_cost,
        "type": "active", "effects": effects,
    }


def generate_class_skills(cls_key, seed_offset):
    rng       = random.Random(42 + seed_offset)
    skills    = []
    used_names = set()
    used_ids   = set()

    # Build gates × tier matrix
    # 14 gates, 100 skills spread as pyramid: 26/29/20/15/10
    tier_queue = []
    for t in TIERS:
        tier_queue.extend([t] * t["count"])
    rng.shuffle(tier_queue)

    # Sort so higher tiers appear at later gates
    tier_order = {t["id"]: i for i, t in enumerate(TIERS)}
    tier_queue.sort(key=lambda t: tier_order[t["id"]])

    idx = 0
    for g_idx, gate in enumerate(GATES):
        skills_this_gate = len(tier_queue) // len(GATES)
        if g_idx < (len(tier_queue) % len(GATES)):
            skills_this_gate += 1
        batch = tier_queue[idx: idx + skills_this_gate]
        idx  += skills_this_gate

        for s_idx, tier in enumerate(batch):
            is_passive = (s_idx == 0)
            skill = make_skill(cls_key, tier["id"], tier["mult"], gate, g_idx, rng, used_names, used_ids, is_passive)
            skills.append(skill)

    return skills


def generate_levels():
    xp_table = {}
    for lv in range(1, 101):
        # Gentle 1-20, moderate 21-50, steep 51-100
        if lv <= 20:
            xp = int(100 * (lv ** 1.8))
        elif lv <= 50:
            xp = int(150 * (lv ** 2.2))
        else:
            xp = int(200 * (lv ** 2.8))
        xp_table[str(lv)] = xp

    return {
        "levelCap": 100,
        "statGrowthPerLevel": {"str": 2, "agi": 2, "int": 2, "def": 2, "lck": 1, "maxHp": 10, "maxMp": 5},
        "xpTable": xp_table,
    }


def main():
    os.makedirs("data", exist_ok=True)

    # Generate skills for all 9 classes
    all_skills = []
    for i, cls_key in enumerate(CLASSES):
        class_skills = generate_class_skills(cls_key, i * 100)
        all_skills.extend(class_skills)
        print(f"  {cls_key}: {len(class_skills)} skills")

    # Verify no duplicate IDs within a class
    for cls_key in CLASSES:
        cs = [s for s in all_skills if s["classId"] == cls_key]
        ids = [s["id"] for s in cs]
        assert len(ids) == len(set(ids)), f"Duplicate skill IDs in {cls_key}"

    with open("data/skills.json", "w") as f:
        json.dump(all_skills, f, indent=2)
    print(f"\nGenerated {len(all_skills)} skills.")

    tier_config = {
        "tiers": [{"id": t["id"], "multiplier": t["mult"], "emoji": t["emoji"]} for t in TIERS],
        "note": "multiplier applied to primaryStat to compute rawDamage"
    }
    with open("data/skill-tiers.json", "w") as f:
        json.dump(tier_config, f, indent=2)

    levels = generate_levels()
    with open("data/levels.json", "w") as f:
        json.dump(levels, f, indent=2)
    print(f"xpTable levels: {len(levels['xpTable'])} | xp(100) = {levels['xpTable']['100']:,}")


if __name__ == "__main__":
    main()
