import type { GameState } from "../state/game-state.js";
import { canOpenBuildingUpgrades, facilityUpgradeFailure, heroUpgradeFailure, townPriceFailure, treatmentConfirmationFailure } from './town-availability.js';
import type { PendingCombatTransition } from './execution-types.js';
import { currentActorView, currentCombatant } from "./identity.js";
import { actionableRoomProps, currentDecisionRoomId, currentPhysicalArea, currentPhysicalTile, lootFitsExistingStack, MAP_DIRECTIONS, roomPropDecisionOptions, secretExitRoutes, skillIsUsableByCurrentActor, skillNeedsNoTarget } from './workflow-support.js';

export function buildDecision(state: GameState, pendingCombatTransition?: PendingCombatTransition) {
  if (
    state.phase === "modal" ||
    state.currentContext === "tutorial" ||
    state.activeTutorial !== undefined
  ) {
    return {
      kind: "modal",
      prompt: state.activeTutorial?.text ?? state.activeDialog?.text ?? "A modal is blocking input.",
      options: [
        ...(state.activeDialog?.options ?? []).map(({ optionIndex, label }) => ({
          kind: 'choose_dialog_option' as const, optionIndex, label,
        })),
        { kind: "dismiss_modal" as const },
      ],
    };
  }
  if (
    state.combatActive &&
    (state.phase === "combat" || state.phase === "targeting") &&
    pendingCombatTransition !== undefined
  ) {
    return {
      kind: "combat_resolving",
      prompt:
        "The previous combat action has produced semantic evidence, but the turn has not advanced yet. Wait for the actor or turn tick to change before issuing another action.",
      actor: currentActorView(state),
      pending: pendingCombatTransition,
      options: [],
    };
  }
  if (state.phase === "targeting" || state.currentContext === "itemuse") {
    const inventoryItemTargeting = state.currentContext === "itemuse";
    return {
      kind: "targeting_recovery",
      prompt: inventoryItemTargeting
        ? "An inventory item target selector is already open. Cancel it before issuing another action."
        : "A target selector is already open. Reconcile it before issuing a new combat action.",
      selectedSkill: state.selectedSkill,
      currentTarget:
        state.currentTarget === undefined
          ? undefined
          : (({ raw: _raw, ...target }) => target)(state.currentTarget),
      options: [{ kind: "cancel_targeting" as const }],
    };
  }
  if (state.phase === "loading") {
    return {
      kind: "loading",
      prompt: "The expedition loading screen is ready to continue.",
      options: [{ kind: "continue_loading" as const }],
    };
  }
  if (state.currentContext === "results" || state.phase === "results") {
    return {
      kind: "results",
      prompt: "Advance the expedition results one page at a time.",
      results: state.results,
      options: [{ kind: "continue_results" as const }],
    };
  }
  if (state.currentContext === "questdone") {
    return {
      kind: "quest_completion",
      prompt: "Choose whether to return to the Hamlet or continue exploring.",
      options: [
        { kind: "choose_quest_completion" as const, destination: "hamlet" as const },
        { kind: "choose_quest_completion" as const, destination: "continue" as const },
      ],
    };
  }
  if (state.currentContext === "meal") {
    return {
      kind: "camp_meal",
      prompt: "Choose the camping meal after comparing food cost and effects.",
      camp: state.camp,
      options: (state.camp?.meals ?? []).map((meal) => ({
        kind: "choose_camp_meal" as const,
        ...meal,
      })),
    };
  }
  if (state.phase === "camp") {
    return {
      kind: "camp",
      prompt: "Choose a camping skill and optional target, or finish the respite.",
      camp: state.camp,
      skills: state.combatActions.filter((action) => action.kind === "skill"),
      party: state.combatants.filter((actor) => actor.side === "party"),
      options: [
        ...state.combatActions
          .filter((action) => action.kind === "skill")
          .map((action) => ({
            kind: "use_camp_skill" as const,
            skillSlot: action.skillSlot,
            name: action.name,
            details: action.details,
            targetHeroGuid: "omit for self or party skills; choose a party hero GUID for individual skills",
          })),
        ...(state.combatActions.some((action) => action.kind === "rest")
          ? [{ kind: "finish_camp" as const }]
          : []),
      ],
    };
  }
  if (state.loot?.active === true) {
    if (state.currentContext === "inventory") {
      return {
        kind: "loot",
        prompt: "The inventory is covering an open loot window. Return to loot before choosing an item.",
        token: state.loot.token,
        itemCount: state.loot.itemCount,
        items: state.loot.items,
        options: [{ kind: "return_to_loot" as const }],
      };
    }
    return {
      kind: "loot",
      prompt: "Choose whether to take all loot, take one item, or close the loot window.",
      token: state.loot.token,
      itemCount: state.loot.itemCount,
      items: state.loot.items,
      options: [
        { kind: "take_all_loot" as const },
        ...state.loot.items.map((item) => ({
          kind: "take_loot_item" as const,
          itemIndex: item.itemIndex,
          name: item.name,
          amount: item.amount,
        })),
        ...(state.inventoryInfo?.occupiedCount === state.inventoryInfo?.slotCount
          ? state.loot.items
            .filter((item) => !lootFitsExistingStack(state, item))
            .map((item) => ({
              kind: "replace_inventory_with_loot" as const,
              itemIndex: item.itemIndex,
              name: item.name,
              inventorySlot: "choose one occupied inventory slot to discard",
            }))
          : []),
        { kind: "close_loot" as const },
      ],
    };
  }
  if (state.eventOverlay?.active === true) {
    const compatibleItems = state.inventory.filter((item) =>
      state.eventOverlay?.compatibleInventorySlots.includes(item.slot),
    );
    const eventOptions: Array<
      | {
        kind: "choose_event_option";
        optionIndex: number;
        name: string;
        description: string;
      }
      | {
        kind: "use_item_on_event";
        optionIndex: number;
        inventorySlot: number;
        optionName: string;
        itemName: string;
        amount: number;
      }
    > = [];
    for (const option of state.eventOverlay.options) {
      if (!option.enabled) continue;
      if (!option.itemSlot) {
        eventOptions.push({
          kind: "choose_event_option",
          optionIndex: option.optionIndex,
          name: option.name,
          description: option.description,
        });
        continue;
      }
      for (const item of compatibleItems) {
        eventOptions.push({
          kind: "use_item_on_event",
          optionIndex: option.optionIndex,
          inventorySlot: item.slot,
          optionName: option.name,
          itemName: item.name,
          amount: item.amount,
        });
      }
    }
    return {
      kind: "event",
      prompt: "Choose one event option. Item use is only offered for supplies verified by the game as compatible.",
      title: state.eventOverlay.title,
      flavour: state.eventOverlay.flavour,
      pickingItem: state.eventOverlay.pickingItem,
      options: eventOptions,
    };
  }
  const physicalArea = currentPhysicalArea(state);
  if (!state.combatActive && physicalArea?.areaKind === 1) {
    const currentTile = currentPhysicalTile(state);
    const endpointRoomIds = [
      ...new Set(
        (state.dungeonMap?.edges ?? [])
          .filter((edge) => edge.corridorAreaId === physicalArea.areaId)
          .flatMap((edge) => [edge.fromAreaId, edge.toAreaId]),
      ),
    ];
    const observedDoorIds = state.room?.doorDestinations ?? [];
    const destinationRoomId =
      state.navigation?.viaArea === physicalArea.areaId
        ? state.navigation.toArea
        : endpointRoomIds.find((roomId) => !observedDoorIds.includes(roomId));
    const atForwardDoor =
      currentTile !== undefined && currentTile >= physicalArea.tileCount - 1;
    const atSecretDoor = physicalArea.tiles.some(
      (tile) => tile.current && tile.content === 13,
    );
    const canEnterSecretRoom =
      atSecretDoor && !state.navigation?.fromArea.startsWith("sec");
    const activeProps = actionableRoomProps(state);
    return {
      kind: "corridor",
      prompt:
        activeProps.length > 0
          ? activeProps.some((prop) => prop.trap)
            ? "A scouted trap is ahead. Choose its interact action to attempt disarming it before moving."
            : "Resolve the detected corridor interactable before continuing."
          : canEnterSecretRoom
            ? "A discovered secret door is at the party's position. Enter the secret room."
            : atForwardDoor
              ? "The party has reached the forward door. Enter the destination room."
              : "Advance through the corridor until combat, an event, an interactable, a trap, or the forward door interrupts movement.",
      currentAreaId: physicalArea.areaId,
      currentTile,
      tileCount: physicalArea.tileCount,
      destinationRoomId,
      navigation: state.navigation,
      props: activeProps,
      options:
        activeProps.length > 0
          ? roomPropDecisionOptions(state, activeProps)
          : [
            ...(currentTile === 0 && state.navigation !== undefined
              ? [{ kind: "return_to_previous_room" as const }]
              : []),
            atForwardDoor || canEnterSecretRoom
              ? ({ kind: "enter_room" as const })
              : ({ kind: "advance_corridor" as const }),
          ],
    };
  }
  if (state.phase === "traveling") {
    return {
      kind: "traveling",
      prompt: "The party is moving to the selected room; wait for room reconciliation.",
      navigation: state.navigation,
      options: [],
    };
  }
  if (state.phase === "room" && !state.combatActive) {
    const map = state.dungeonMap;
    const currentAreaId = map?.currentAreaId;
    const currentRoomId = currentDecisionRoomId(state);
    const routeOptions =
      map === undefined || currentRoomId === undefined
        ? []
        : currentRoomId.startsWith("sec")
          ? secretExitRoutes(state, currentRoomId).map((route) => {
            const destination = map.areas.find(
              (area) => area.areaId === route.roomId,
            );
            return {
              kind: "travel_to_room" as const,
              roomId: route.roomId,
              direction:
                MAP_DIRECTIONS.find(
                  (candidate) => candidate.direction === route.endpointDirection,
                )?.name ?? `direction_${route.endpointDirection}`,
              corridorAreaId: route.corridorAreaId,
              corridorTiles: route.corridorTiles,
              visited: destination?.visited ?? false,
              knownContents: (destination?.tiles ?? [])
                .filter((tile) => tile.visible)
                .map((tile) => tile.content),
            };
          })
          : map.edges
            .filter((edge) => edge.fromAreaId === currentRoomId)
            .map((edge) => {
              const destination = map.areas.find(
                (area) => area.areaId === edge.toAreaId,
              );
              return {
                kind: "travel_to_room" as const,
                roomId: edge.toAreaId,
                direction:
                  MAP_DIRECTIONS.find(
                    (candidate) => candidate.direction === edge.direction,
                  )?.name ?? `direction_${edge.direction}`,
                corridorAreaId: edge.corridorAreaId,
                corridorTiles: edge.corridorTiles,
                visited: destination?.visited ?? false,
                knownContents: (destination?.tiles ?? [])
                  .filter((tile) => tile.visible)
                  .map((tile) => tile.content),
              };
            });
    const activeProps = actionableRoomProps(state);
    return {
      kind: "room",
      prompt:
        activeProps.length > 0
          ? "Resolve the room interactable before choosing another route."
          : map === undefined
            ? "The room is clear, but a map snapshot is not available yet."
            : currentRoomId === undefined
              ? "The physical map position is between rooms and the current decision room could not be resolved. Reconcile before moving."
              : "Choose an adjacent destination room. Route choice belongs to the model.",
      room: state.room,
      currentAreaId,
      currentRoomId,
      props: activeProps,
      options:
        activeProps.length > 0
          ? roomPropDecisionOptions(state, activeProps)
          : routeOptions,
    };
  }
  if (state.combatActive && state.phase === "combat") {
    const usableSkills = state.combatActions.filter(
      (action) =>
        action.kind === "skill" &&
        skillIsUsableByCurrentActor(state, action),
    );
    const targets = state.combatants.map((combatant) => ({
      targetGuid: combatant.actorGuid,
      side: combatant.side,
      slot: combatant.slot,
      slotEnd: combatant.slotEnd,
      name: combatant.name,
      currentHp: combatant.currentHp,
      maxHp: combatant.maxHp,
      stress: combatant.stress,
      conditions: combatant.conditions,
      details: combatant.details,
      resists: combatant.resists,
    }));
    return {
      kind: "combat_turn",
      prompt:
        state.circusCombat?.active === true
          ? "Choose an arena skill and, when required, its intended target; health and stress are both tactical win conditions."
          : "Choose a skill and, when it requires one, its intended target; the Copilot will complete targeting and confirmation.",
      actor: currentActorView(state),
      skills: usableSkills
        .map((action) => ({
          skillSlot: action.skillSlot,
          skillElementId: action.elementId,
          name: action.name,
          details: action.details,
        })),
      targets,
      options: [
        ...usableSkills
          .map((action) => ({
            kind: "use_skill" as const,
            actorGuid: currentCombatant(state)?.actorGuid,
            skillElementId: action.elementId,
            skillSlot: action.skillSlot,
            name: action.name,
            target: skillNeedsNoTarget(action)
              ? "omit; this skill reports no target"
              : "choose one entry from decision.targets",
          })),
        ...state.combatActions
          .filter((action) => action.kind === "pass")
          .map(() => ({ kind: "pass_turn" as const })),
        ...state.combatActions
          .filter((action) => action.kind === "reorder")
          .map(() => ({ kind: "move_hero" as const, toSlot: "choose rank 1 through 4" })),
        ...(state.circusCombat?.active === true ? [] : [{ kind: "retreat_combat" as const }]),
      ],
    };
  }
  if (state.phase === "town") {
    return {
      kind: "town",
      prompt: "Choose an unlocked town location.",
      wallet: state.townWallet,
      locations: state.townLocations.map(({ id, name, unlocked, screen, district, offSave, isNew }) =>
        ({ id, name, unlocked, screen, district, offSave, isNew })),
      options: [
        ...state.townLocations
          .filter((location) => location.unlocked && location.screen)
          .map((location) => ({
            kind: "open_town_location" as const,
            locationId: location.id,
            name: location.name,
          })),
        { kind: "open_embark" as const, name: "远征" },
      ],
    };
  }
  if (state.phase === "embark") {
    return {
      kind: "embark_planning",
      prompt: "Choose a quest before forming the expedition party.",
      selectedQuestIndex: state.expedition?.selectedQuestIndex,
      roster: state.partyPlanning?.rosterCandidates.map(({ heroGuid, name, state, missing, building, heroClass, level,
        healthText, stressText, weaponLevel, armourLevel, quirks, diseases }) =>
      ({
        heroGuid, name, state, missing, building, heroClass, level, healthText, stressText,
        weaponLevel, armourLevel, quirks, diseases
      })),
      party: state.partyPlanning?.slots.map(({ position, heroGuid, name }) => ({ position, heroGuid, name })),
      locations: state.expedition?.locations ?? [],
      options: [
        ...(state.expedition?.quests ?? [])
          .filter((quest) => quest.onScreen)
          .map((quest) => ({
            kind: "select_embark_quest" as const,
            questIndex: quest.questIndex,
            questId: quest.questId,
            dungeonId: quest.dungeonId,
            length: quest.length,
            difficulty: quest.difficulty,
            details: quest.details,
            selected:
              quest.questIndex === state.expedition?.selectedQuestIndex,
          })),
        ...((state.expedition?.selectedQuestIndex ?? -1) < 0
          ? []
          : [
            {
              kind: "form_embark_party" as const,
              frontToBack: [
                "choose rank 1 heroGuid",
                "choose rank 2 heroGuid",
                "choose rank 3 heroGuid",
                "choose rank 4 heroGuid",
              ],
            },
          ]),
        ...(state.partyPlanning?.filledCount === 4
          ? [{ kind: "proceed_to_provision" as const }]
          : []),
        { kind: 'return_to_town' as const },
      ],
    };
  }
  if (state.phase === "provision") {
    return {
      kind: "provision",
      prompt: "Choose supplies for the selected expedition.",
      wallet: {
        gold: state.provisioning?.gold,
        shards: state.provisioning?.shards,
      },
      bagTotal: state.provisioning?.bagTotal,
      bag: (state.provisioning?.items ?? []).filter(
        (item) => item.section === 1 && item.amount > 0,
      ),
      options: [
        ...(state.provisioning?.items ?? [])
          .filter((item) => item.section === 0 && item.amount > 0)
          .map((item) => ({
            kind: "buy_provision" as const,
            itemKey: item.itemKey,
            available: item.amount,
            goldPrice: item.goldPrice,
            shardPrice: item.shardPrice,
            quantity: "choose an integer quantity",
          })),
        { kind: "start_expedition" as const },
        { kind: 'return_to_town' as const },
      ],
    };
  }
  if (state.phase === "circus") {
    const circus = state.circus;
    return {
      kind: "circus_lineup",
      prompt: "Choose an arena contestant by stable hero address and destination rank.",
      contestants: circus?.contestants ?? [],
      slots: circus?.slots ?? [],
      options: (circus?.contestants ?? [])
        .filter((contestant) => !contestant.dlcLocked)
        .flatMap((contestant) => Array.from({ length: circus?.slotCount ?? 4 }, (_, slot) => ({
          kind: "assign_circus_contestant" as const,
          heroAddress: contestant.heroAddress,
          name: contestant.name,
          heroClass: contestant.heroClass,
          rank: (circus?.slotCount ?? 4) - slot,
        }))),
    };
  }
  if (state.circusCombat?.active === true && state.circusCombat.pickOpen) {
    return {
      kind: "circus_actor_selection",
      prompt: "Choose which eligible arena hero acts next. The Copilot will activate that hero through the game's internal battle interface.",
      battleState: state.circusCombat.battleState,
      party: state.combatants.filter((actor) => actor.side === "party"),
      enemies: state.combatants.filter((actor) => actor.side === "enemy"),
      options: state.circusCombat.heroes
        .filter((hero) => hero.canActivate && hero.actorGuid > 0)
        .map((hero) => ({ kind: "activate_circus_hero" as const, actorGuid: hero.actorGuid, name: hero.name })),
    };
  }
  if (
    state.phase === "building" &&
    state.currentBuilding === "stage_coach" && state.buildingDetails?.mode !== 1
  ) {
    return {
      kind: "stage_coach",
      prompt: "Choose one available hero to recruit.",
      roster: state.recruitment,
      candidates: state.buildingHeroes,
      options: [
        ...(state.recruitment && state.recruitment.rosterCount < state.recruitment.rosterCapacity ? state.buildingHeroes : []).map((hero) => ({
          kind: "recruit_stage_coach_hero" as const,
          heroAddress: hero.heroAddress,
          name: hero.name,
        })),
        ...(canOpenBuildingUpgrades(state) ? [{ kind: 'open_building_upgrades' as const }] : []),
        { kind: "close_building" as const },
      ],
    };
  }
  if (state.phase === "building") {
    const details = state.buildingDetails;
    return {
      kind: "building",
      prompt: "Choose a verified building action by stable hero, option, item, or activity identity.",
      building: state.currentBuilding,
      wallet: state.townWallet,
      details,
      options: [
        ...(details?.heroes ?? []).map((hero) => ({
          kind: "select_building_hero" as const, heroGuid: hero.heroGuid, name: hero.name,
        })),
        ...(details?.heroOptions ?? []).flatMap((option) =>
          option.stepDetails
            .filter((step) => heroUpgradeFailure(state, option, step) === undefined)
            .map((step) => ({
              kind: "buy_hero_upgrade" as const,
              heroGuid: details?.selectedHeroGuid,
              optionId: option.optionId,
              stepCode: step.code,
              name: option.name,
              cost: step.cost,
              currency: step.currency,
            }))),
        ...(details?.shopItems ?? []).filter((item) =>
          townPriceFailure(state, item.priceKnown, item.price, item.currency) === undefined).map((item) => ({
          kind: "buy_town_item" as const, itemId: item.itemId, name: item.name,
          price: item.priceKnown ? item.price : undefined,
        })),
        ...(details?.activities ?? []).flatMap<Record<string, unknown>>((activity) => {
          if (activity.committedHeroGuid !== undefined || activity.pendingHeroGuid !== undefined) {
            return [
              ...(activity.pendingHeroGuid !== undefined && treatmentConfirmationFailure(state, activity.activityId, activity.slot, activity.pendingHeroGuid) === undefined
                ? [{ kind: 'confirm_town_treatment', activityId: activity.activityId, slot: activity.slot, heroGuid: activity.pendingHeroGuid }] : []),
              ...(details?.treatments ?? []).filter((choice) => choice.activityId === activity.activityId && choice.slot === activity.slot)
                .map((choice) => ({ kind: 'choose_town_treatment', activityId: choice.activityId, slot: choice.slot,
                  heroGuid: activity.pendingHeroGuid, quirkId: choice.quirkId, mode: choice.mode, name: choice.name, operation: choice.mode === 1 ? 'lock' : 'remove',
                  chosen: choice.chosen, price: choice.priceKnown ? choice.price : undefined, currency: choice.currency })),
              {
              kind: "cancel_town_activity" as const,
              activityId: activity.activityId, slot: activity.slot
            }];
          }
          if (activity.occupant >= 0 || activity.locked || activity.eventLocked) return [];
          return (details?.activityCandidates ?? []).filter((hero) =>
            hero.activityId === activity.activityId && hero.slot === activity.slot &&
            hero.known && hero.eligible && hero.affordable).map((hero) => ({
            kind: activity.treatment ? 'prepare_town_treatment' as const : "assign_town_activity" as const, activityId: activity.activityId,
            slot: activity.slot, heroGuid: hero.heroGuid, heroName: hero.name,
          }));
        }),
        ...(canOpenBuildingUpgrades(state) ? [{ kind: "open_building_upgrades" as const }] : []),
        ...(details?.upgrades ?? []).flatMap((upgrade) =>
          facilityUpgradeFailure(state, upgrade) === undefined ? [{
            kind: "buy_building_upgrade" as const,
            trackId: upgrade.trackId,
            stepCode: String.fromCharCode(97 + upgrade.next),
            name: upgrade.name,
            costs: upgrade.costs, description: upgrade.description,
          }] : []),
        { kind: "close_building" as const },
      ],
    };
  }
  return {
    kind: "observe",
    prompt: "No verified semantic action is exposed for the current screen yet.",
    options: [],
  };
}
