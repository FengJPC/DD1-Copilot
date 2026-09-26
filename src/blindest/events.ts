export interface EventBase {
  tick: number;
  raw: string;
}

export type BlindestEvent =
  | (EventBase & { kind: "preparation_snapshot_started"; section: "party" | "provision" })
  | (EventBase & { kind: "building_snapshot_started"; buildingId: string; mode: number })
  | (EventBase & { kind: "building_snapshot_completed"; buildingId: string })
  | (EventBase & {
      kind: "town_wallet_observed";
      gold: number; bust: number; portrait: number; deed: number; crest: number; shard: number;
    })
  | (EventBase & { kind: "provision_wallet_observed"; gold: number; shards: number; bagTotal: number })
  | (EventBase & { kind: "context_changed"; context: string })
  | (EventBase & {
      kind: "building_opened";
      buildingId: string;
      mode: number;
    })
  | (EventBase & {
      kind: "town_location_observed";
      row: number;
      id: string;
      elementId: string;
      unlocked: boolean;
      screen: boolean;
      district: boolean;
      offSave: boolean;
      isNew: boolean;
      name: string;
    })
  | (EventBase & {
      kind: "town_map_ready";
      layer: number;
      locationCount: number;
      selectedRow: number;
    })
  | (EventBase & {
      kind: "building_hero_observed";
      row: number;
      slot: number;
      heroAddress: string;
      name: string;
      elementId: string;
    })
  | (EventBase & {
      kind: "recruit_pending";
      slot: number;
      heroAddress: string;
      name: string;
      rosterCount: number;
      rosterCapacity: number;
    })
  | (EventBase & {
      kind: "hero_recruited";
      previousRosterCount: number;
      rosterCount: number;
    })
  | (EventBase & { kind: "recruit_cancelled"; slot: number })
  | (EventBase & {
      kind: "hero_observed";
      heroAddress: string;
      classAddress: string;
      name: string;
      heroClass: string;
    })
  | (EventBase & {
      kind: "hero_rank_observed";
      xp: number;
      level: number;
    })
  | (EventBase & {
      kind: "tutorial_opened";
      tutorialId: string;
      text: string;
    })
  | (EventBase & { kind: "tutorial_closed"; context: string })
  | (EventBase & { kind: "circus_snapshot_started"; rowCount: number; slotCount: number })
  | (EventBase & {
      kind: "circus_contestant_observed";
      row: number;
      heroAddress: string;
      name: string;
      heroClass: string;
      inLineup: boolean;
      dlcLocked: boolean;
    })
  | (EventBase & {
      kind: "circus_slot_observed";
      slot: number;
      rank: number;
      heroAddress?: string;
      name: string;
      heroClass: string;
    })
  | (EventBase & { kind: "circus_snapshot_completed" })
  | (EventBase & {
      kind: "circus_assignment_observed";
      heroAddress: string;
      slot: number;
      observed: boolean;
    })
  | (EventBase & {
      kind: "circus_combat_snapshot_started";
      pickOpen: boolean;
      battleState: number;
      partyCount: number;
    })
  | (EventBase & {
      kind: "circus_combat_hero_observed";
      index: number;
      actorGuid: number;
      actorAddress: string;
      canActivate: boolean;
      active: boolean;
      name: string;
    })
  | (EventBase & { kind: "circus_combat_snapshot_completed" })
  | (EventBase & {
      kind: "circus_hero_activation_observed";
      actorGuid: number;
      actorAddress: string;
      observed: boolean;
    })
  | (EventBase & {
      kind: "embark_ready";
      questCount: number;
      locationCount: number;
      cursorColumn: number;
      cursorRow: number;
    })
  | (EventBase & {
      kind: "embark_state_observed";
      questScreenState: number;
      selectedQuestIndex: number;
      specialQuestIndex: number;
    })
  | (EventBase & {
      kind: "embark_location_observed";
      column: number;
      dungeonId: string;
      questCount: number;
    })
  | (EventBase & {
      kind: "embark_quest_observed";
      row: number;
      questIndex: number;
      questId: string;
      dungeonId: string;
      length: number;
      difficulty: number;
      elementId: string;
      onScreen: boolean;
    })
  | (EventBase & { kind: "embark_quest_detail_observed"; questIndex: number; line: number; text: string })
  | (EventBase & {
      kind: "embark_cursor_location_changed";
      previousColumn: number;
      column: number;
      locationCount: number;
      questCount: number;
    })
  | (EventBase & { kind: "embark_quest_selected"; questIndex: number })
  | (EventBase & {
      kind: "embark_forward_outcome";
      previousQuestScreen: boolean;
      questScreen: boolean;
      previousProvision: boolean;
      provision: boolean;
      previousLayer: number;
      layer: number;
    })
  | (EventBase & {
      kind: "party_slot_observed";
      heroGuid?: number;
      slot: number;
      position: number;
      heroAddress: string;
      entryAddress: string;
      name: string;
      barred: boolean;
      elementId: string;
    })
  | (EventBase & {
      kind: "party_lineup_ready";
      slotCount: number;
      filledCount: number;
    })
  | (EventBase & { kind: "party_lineup_closed"; reason: string })
  | (EventBase & { kind: "provision_ready" })
  | (EventBase & { kind: "provision_section_observed"; section: number })
  | (EventBase & {
      kind: "provision_item_observed";
      slot: number;
      amount: number;
      itemType: string;
      itemId: string;
      priceKnown: boolean;
      goldPrice: number;
      shardPrice: number;
      freeCount: number;
    })
  | (EventBase & {
      kind: "provision_transaction_observed";
      previousGold: number;
      gold: number;
      previousShards: number;
      shards: number;
      previousBagTotal: number;
      bagTotal: number;
    })
  | (EventBase & { kind: "loading_continue_ready"; text: string })
  | (EventBase & {
      kind: "room_view_observed";
      partyCount: number;
      enemyCount: number;
      propCount: number;
      doorCount: number;
      wave: boolean;
      wayOn: boolean;
    })
  | (EventBase & { kind: "room_doors_started"; doorCount: number })
  | (EventBase & {
      kind: "room_door_observed";
      destinationAreaId: string;
    })
  | (EventBase & {
      kind: "map_move_started";
      fromArea: string;
      toArea: string;
      viaArea: string;
      doorTile: number;
    })
  | (EventBase & {
      kind: "tile_step_arrived";
      tile: number;
      newArea: boolean;
      description: string;
    })
  | (EventBase & {
      kind: "map_snapshot_started";
      areaCount: number;
      currentAreaId: string;
    })
  | (EventBase & {
      kind: "map_area_observed";
      areaIndex: number;
      areaId: string;
      areaKind: number;
      current: boolean;
      tileCount: number;
      visited: boolean;
    })
  | (EventBase & {
      kind: "map_tile_observed";
      areaId: string;
      tileIndex: number;
      tileType: number;
      content: number;
      knowledge: number;
      visible: boolean;
      visited: boolean;
      current: boolean;
    })
  | (EventBase & {
      kind: "map_edge_observed";
      fromAreaId: string;
      direction: number;
      toAreaId: string;
      corridorAreaId: string;
      corridorTiles: number;
    })
  | (EventBase & {
      kind: "map_position_observed";
      areaId: string;
      tileIndex: number;
    })
  | (EventBase & { kind: "map_snapshot_completed" })
  | (EventBase & {
      kind: "roster_hero_observed";
      heroGuid?: number;
      row: number;
      entryAddress: string;
      name: string;
      state: number;
      building: string;
      missing: boolean;
    })
  | (EventBase & {
      kind: "roster_profile_observed";
      heroGuid: number; name: string; heroClass: string; level: number;
      healthText: string; stressText: string; weaponLevel: number; armourLevel: number;
    })
  | (EventBase & {
      kind: "roster_profile_detail_observed";
      heroGuid: number; category: "quirk" | "disease"; line: number; text: string;
    })
  | (EventBase & {
      kind: "building_activity_observed";
      row: number; activityId: string; activityOrder: number; slot: number; slotCount: number;
      elementId: string; committedHeroGuid?: number; pendingHeroGuid?: number; pendingHeroName: string;
      occupant: number; locked: boolean; eventLocked: boolean; costsMoney: boolean;
    })
  | (EventBase & {
      kind: "building_shop_item_observed";
      row: number; slot: number; itemId: string; name: string; priceKnown: boolean;
      price: number; elementId: string;
    })
  | (EventBase & { kind: "building_shop_item_effects_observed"; row: number; effects: string })
  | (EventBase & { kind: "building_shop_item_metadata_observed"; row: number; rarity: string; classRequirement: string })
  | (EventBase & { kind: "building_memorial_count_observed"; count: number })
  | (EventBase & { kind: "building_memorial_observed"; row: number; text: string })
  | (EventBase & { kind: "building_hero_table_observed"; selectedHeroGuid?: number; heroCount: number })
  | (EventBase & { kind: "building_roster_hero_observed"; row: number; heroGuid: number; name: string })
  | (EventBase & {
      kind: "building_hero_option_observed";
      column: number; optionId: string; optionHash: string; optionKind: number; skillIndex: number;
      level: number; selected: boolean; steps: number; bought: number; next: number; name: string;
    })
  | (EventBase & {
      kind: "building_hero_option_step_observed";
      optionId: string; code: string; purchased: boolean; armed?: boolean;
      cost: number; currency: string; resolveRequired: number; elementId: string; live: boolean;
    })
  | (EventBase & {
      kind: "building_upgrade_track_observed";
      track: number; trackHash: string; trackId: string; knownDefinition: boolean;
      steps: number; armed: number; bought: number; next: number; name: string;
    })
  | (EventBase & {
      kind: "building_upgrade_step_observed";
      track: number; code: string; armed: number;
    })
  | (EventBase & {
      kind: "roster_picker_ready";
      heroCount: number;
      selectedRow: number;
      pickSlot: number;
    })
  | (EventBase & {
      kind: "party_hero_added";
      name: string;
      callSucceeded: boolean;
      previousState: number;
      state: number;
      slot: number;
      position: number;
    })
  | (EventBase & { kind: "combat_started" })
  | (EventBase & { kind: "combat_ended" })
  | (EventBase & {
      kind: "actor_changed";
      actorAddress: string;
      name: string;
      heroClass: string;
      currentHp: number;
      maxHp: number;
      stress: number;
      maxStress: number;
    })
  | (EventBase & {
      kind: "skill_observed";
      skillId: string;
      name: string;
    })
  | (EventBase & {
      kind: "skill_armed";
      name: string;
      skillSlot: number;
      elementId: string;
    })
  | (EventBase & {
      kind: "target_preview";
      targetIndex: number;
      targetCount: number;
      side: "party" | "enemy";
      sideIndex: number;
      slot: number;
      area: boolean;
      name: string;
      details: string;
      hitPercent?: number;
      damageMin?: number;
      damageMax?: number;
      critPercent?: number;
      currentHp?: number;
      maxHp?: number;
    })
  | (EventBase & {
      kind: "combat_result";
      actorAddress: string;
      resultType: string;
      text: string;
    })
  | (EventBase & {
      kind: "dungeon_announcement";
      slot: number;
      slotCount: number;
      actorAddress: string;
      text: string;
    })
  | (EventBase & {
      kind: "combat_buff";
      actorAddress: string;
      stat: number;
      subtype: string;
      amount: number;
      rounds: number;
      polarity: number;
    })
  | (EventBase & {
      kind: "event_opened";
      skin: number;
      rowCount: number;
      title: string;
    })
  | (EventBase & { kind: "event_closed" })
  | (EventBase & { kind: "event_option_activated"; name: string })
  | (EventBase & { kind: "agent_state_started" })
  | (EventBase & {
      kind: "inventory_snapshot_started";
      slotCount: number;
      occupiedCount: number;
    })
  | (EventBase & { kind: "inventory_snapshot_completed" })
  | (EventBase & {
      kind: "room_prop_observed";
      propIndex: number;
      address: string;
      active: boolean;
      trap: boolean;
      reachable: boolean;
      direction: number;
      distance: number;
      name: string;
    })
  | (EventBase & {
      kind: "inventory_item_observed";
      slot: number;
      amount: number;
      itemType: string;
      itemId: string;
      itemKey: string;
      name: string;
    })
  | (EventBase & {
      kind: "event_snapshot_started";
      skin: number;
      rowCount: number;
      pickingItem: boolean;
      title: string;
      flavour: string;
    })
  | (EventBase & {
      kind: "event_option_observed";
      optionIndex: number;
      name: string;
      description: string;
      itemSlot: boolean;
      enabled: boolean;
    })
  | (EventBase & {
      kind: "event_item_compatibility_observed";
      slot: number;
      works: boolean;
    })
  | (EventBase & { kind: "event_snapshot_completed" })
  | (EventBase & { kind: "loot_snapshot_started"; itemCount: number })
  | (EventBase & {
      kind: "loot_item_observed";
      itemIndex: number;
      poolSlot: number;
      amount: number;
      itemType: string;
      itemId: string;
      itemKey: string;
      name: string;
    })
  | (EventBase & { kind: "loot_snapshot_completed" })
  | (EventBase & {
      kind: "inventory_consolidated";
      merges: number;
      freed: number;
      accepted: boolean;
    })
  | (EventBase & {
      kind: "trap_chance_observed";
      actorAddress: string;
      heroIndex: number;
      chance: number;
    })
  | (EventBase & {
      kind: "trap_interaction_started";
      propAddress: string;
      actorAddress: string;
      heroGuid?: number;
      heroIndex: number;
      deliberate: boolean;
    })
  | (EventBase & {
      kind: "trap_result";
      propAddress: string;
      actorAddress: string;
      heroGuid?: number;
      outcome: "disarmed" | "triggered" | "unknown";
      hpDelta: number;
      stressDelta: number;
      deliberate: boolean;
    })
  | (EventBase & {
      kind: "quirk_loot_withheld";
      actorAddress: string;
      heroGuid?: number;
      quirkId: string;
      text: string;
    })
  | (EventBase & {
      kind: "combatant_observed";
      side: "party" | "enemy";
      sideIndex: number;
      slot: number;
      slotEnd: number;
      actorAddress: string;
      actorGuid?: number;
      heroGuid?: number;
      active: boolean;
      name: string;
      healthText: string;
      stressText: string;
      conditions: string;
    })
  | (EventBase & {
      kind: "actor_detail_observed";
      actorAddress: string;
      category: "summary" | "resist" | "quirk" | "disease";
      line: number;
      text: string;
    })
  | (EventBase & {
      kind: "combat_action_observed";
      actionKind: "skill" | "pass" | "reorder" | "rest" | "portrait";
      actionIndex: number;
      skillSlot?: number;
      elementId: string;
      name: string;
    })
  | (EventBase & {
      kind: "skill_detail_observed";
      skillSlot: number;
      line: number;
      text: string;
    })
  | (EventBase & {
      kind: "light_observed";
      lightKind: "torch" | "ambient";
      value: number;
      level: number;
      text: string;
    })
  | (EventBase & {
      kind: "camp_observed";
      phase: number;
      points: number;
      mealOptionCount: number;
    })
  | (EventBase & {
      kind: "camp_meal_observed";
      optionIndex: number;
      foodRequired: number;
      foodAvailable: number;
      text: string;
    })
  | (EventBase & {
      kind: "quest_observed";
      rowCount: number;
      goalCount: number;
      button: "none" | "flee" | "abandon" | "regroup" | "finish";
      complete: boolean;
    })
  | (EventBase & {
      kind: "quest_row_observed";
      row: number;
      rowKind: "goal" | "button" | "wave";
      text: string;
    })
  | (EventBase & {
      kind: "results_observed";
      state: number;
      rowCount: number;
      heroCount: number;
    })
  | (EventBase & {
      kind: "results_row_observed";
      row: number;
      text: string;
    })
  | (EventBase & {
      kind: "results_hero_observed";
      heroIndex: number;
      rowCount: number;
    })
  | (EventBase & {
      kind: "results_hero_row_observed";
      heroIndex: number;
      row: number;
      text: string;
    })
  | (EventBase & { kind: "agent_state_completed" })
  | (EventBase & {
      kind: "enemy_count_changed";
      previous: number;
      current: number;
    })
  | (EventBase & {
      kind: "loot_opened";
      itemCount: number;
      token: string;
    })
  | (EventBase & { kind: "loot_closed" });

export interface ParsedLogLine {
  tick: number;
  message: string;
  raw: string;
}
