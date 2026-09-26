import { z } from "zod";

export const copilotActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("open_town_location"),
    locationId: z.string().min(1).max(80),
  }),
  z.strictObject({ kind: z.literal("open_embark") }),
  z.strictObject({
    kind: z.literal("select_embark_quest"),
    questIndex: z.number().int().min(0).max(0x7fffffff).optional(),
    questId: z.string().min(1).max(160).optional(),
  }),
  z.strictObject({
    kind: z.literal("form_embark_party"),
    frontToBack: z.array(z.number().int().positive().max(0xffffffff)).length(4),
  }),
  z.strictObject({ kind: z.literal("proceed_to_provision") }),
  z.strictObject({
    kind: z.literal("buy_provision"),
    itemKey: z.string().min(1).max(80),
    quantity: z.number().int().min(1).max(32),
  }),
  z.strictObject({ kind: z.literal("start_expedition") }),
  z.strictObject({ kind: z.literal("continue_loading") }),
  z.strictObject({
    kind: z.literal("travel_to_room"),
    roomId: z.string().min(1).max(16),
  }),
  z.strictObject({ kind: z.literal("advance_corridor") }),
  z.strictObject({ kind: z.literal("enter_room") }),
  z.strictObject({ kind: z.literal("return_to_previous_room") }),
  z.strictObject({
    kind: z.literal("approach_room_prop"),
    propIndex: z.number().int().min(0).max(31),
  }),
  z.strictObject({
    kind: z.literal("interact_room_prop"),
    propIndex: z.number().int().min(0).max(31),
    heroGuid: z.number().int().positive().max(0xffffffff),
    heroIndex: z.number().int().min(0).max(7).optional(),
  }),
  z.strictObject({
    kind: z.literal("choose_event_option"),
    optionIndex: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    kind: z.literal("use_item_on_event"),
    optionIndex: z.number().int().min(0).max(15),
    inventorySlot: z.number().int().min(0).max(31),
  }),
  z.strictObject({ kind: z.literal("take_all_loot") }),
  z.strictObject({ kind: z.literal("return_to_loot") }),
  z.strictObject({
    kind: z.literal("take_loot_item"),
    itemIndex: z.number().int().min(0).max(127),
  }),
  z.strictObject({
    kind: z.literal("replace_inventory_with_loot"),
    inventorySlot: z.number().int().min(0).max(31),
    itemIndex: z.number().int().min(0).max(127),
  }),
  z.strictObject({ kind: z.literal("close_loot") }),
  z.strictObject({
    kind: z.literal("move_hero"),
    toSlot: z.number().int().min(1).max(4),
  }),
  z.strictObject({
    kind: z.literal("use_inventory_item"),
    inventorySlot: z.number().int().min(0).max(31),
    targetHeroGuid: z.number().int().positive().optional(),
    targetIndex: z.number().int().min(0).max(7).optional(),
  }),
  z.strictObject({
    kind: z.literal("discard_inventory_item"),
    inventorySlot: z.number().int().min(0).max(31),
  }),
  z.strictObject({ kind: z.literal("use_torch") }),
  z.strictObject({
    kind: z.literal("choose_camp_meal"),
    optionIndex: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    kind: z.literal("use_camp_skill"),
    targetHeroGuid: z.number().int().positive().optional(),
    skillSlot: z.number().int().min(1).max(4),
    targetIndex: z.number().int().min(0).max(7).optional(),
  }),
  z.strictObject({ kind: z.literal("finish_camp") }),
  z.strictObject({ kind: z.literal("retreat_combat") }),
  z.strictObject({ kind: z.literal("abandon_expedition") }),
  z.strictObject({ kind: z.literal("finish_quest") }),
  z.strictObject({
    kind: z.literal("choose_quest_completion"),
    destination: z.enum(["hamlet", "continue"]),
  }),
  z.strictObject({ kind: z.literal("continue_results") }),
  z.strictObject({
    kind: z.literal("recruit_stage_coach_hero"),
    heroAddress: z.string().regex(/^[0-9A-F]+$/u),
  }),
  z.strictObject({
    kind: z.literal("select_building_hero"),
    heroGuid: z.number().int().positive().max(0xffffffff),
  }),
  z.strictObject({
    kind: z.literal("buy_hero_upgrade"),
    heroGuid: z.number().int().positive().max(0xffffffff),
    optionId: z.string().min(1).max(96),
    stepCode: z.string().length(1),
  }),
  z.strictObject({ kind: z.literal("buy_town_item"), itemId: z.string().min(1).max(96) }),
  z.strictObject({
    kind: z.literal("assign_town_activity"),
    activityId: z.string().min(1).max(64),
    slot: z.number().int().min(1).max(16),
    heroGuid: z.number().int().positive().max(0xffffffff),
  }),
  z.strictObject({
    kind: z.literal("cancel_town_activity"),
    activityId: z.string().min(1).max(64),
    slot: z.number().int().min(1).max(16),
  }),
  z.strictObject({ kind: z.literal("open_building_upgrades") }),
  z.strictObject({
    kind: z.literal("buy_building_upgrade"),
    trackId: z.string().min(1).max(96),
    stepCode: z.string().length(1),
  }),
  z.strictObject({ kind: z.literal("close_building") }),
  z.strictObject({
    kind: z.literal("assign_circus_contestant"),
    heroAddress: z.string().regex(/^(?:0x)?[0-9A-F]+$/iu),
    rank: z.number().int().min(1).max(4),
  }),
  z.strictObject({
    kind: z.literal("activate_circus_hero"),
    actorGuid: z.number().int().positive().max(0xffffffff),
  }),
  z.strictObject({ kind: z.literal("dismiss_modal") }),
  z.strictObject({ kind: z.literal("cancel_targeting") }),
  z.strictObject({ kind: z.literal("pass_turn") }),
  z.strictObject({
    kind: z.literal("use_skill"),
    actorGuid: z.number().int().positive().max(0xffffffff).optional(),
    skillElementId: z.string().regex(/^0x[0-9a-f]+$/i).optional(),
    skillSlot: z.number().int().min(1).max(4).optional(),
    target: z.strictObject({
      targetGuid: z.number().int().positive().optional(),
      side: z.enum(["party", "enemy"]).optional(),
      slot: z.number().int().min(1).max(8).optional(),
    }).optional(),
  }),
]);

export type CopilotAction = z.infer<typeof copilotActionSchema>;

export const actionRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  rationale: z.string().min(1).max(500).optional(),
  action: copilotActionSchema,
});
