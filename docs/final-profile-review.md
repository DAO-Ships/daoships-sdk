# DAO profile update planning

The indexer merges `name`, `description` and `avatar` into DAO columns. Other supported profile fields—`banner`, `theme`, `links`, `tags`, and `chainId`—are read from the latest profile record. Sending only a changed name would therefore remove previously recorded banner/theme/link/tag metadata from that latest-record view.

`buildDaoProfileUpdate(daoAddress, current, patch)` now builds a detached, validated `DaoProfileUpdateMetadata` payload or returns `null` when nothing changes.

```ts
const update = buildDaoProfileUpdate(daoAddress, currentProfileFields, {
  name: 'New DAO name',
  banner: null,
});
if (update) {
  const call = encodePosterPost(posterAddress, POSTER_TAGS.DAO_PROFILE, update);
  // Route this unsigned call through the DAO's authorized governance/vault workflow.
}
```

The caller supplies complete current field state, combining the three materialized DAO columns with fields from the latest authenticated profile record. `current` and `patch` contain profile fields only, without `daoAddress` or `schemaVersion`. An omitted or `undefined` patch field preserves its current value; `null` clears it. A provided nested object or array replaces that complete field, rather than merging individual link/theme keys. `null` current fields are treated as absent.

Changed materialized columns are emitted as their new values or explicit `null`; unchanged materialized columns are omitted. Every remaining record-only field is carried into the new payload. Clearing a record-only field omits it from the replacement record instead of sending a raw `null` rejected by the Poster schema. Clearing the last record-only field can therefore return the valid minimal `{ daoAddress }` payload. Existing unchanged record-only fields alone do not trigger a post.

No-change comparison ignores object key order, preserves array order, and compares the sanitized values produced by the existing Poster builder. All current values, replacement values, and the combined outgoing payload pass the same bounded Poster validation. Unknown fields, nonplain objects, accessors, inherited records, invalid URLs/theme tokens, and oversized payloads are rejected. Output objects/arrays are cloned and do not share mutable references with the supplied state or patch.

This helper does not load or authenticate metadata, protect against concurrent profile updates, or authorize posting. Incomplete/stale current state can still overwrite newer record-only fields; integrations must obtain and review the current profile before publishing. Initial profile creation continues to use `POSTER_TAGS.DAO_PROFILE_INITIAL` with its mandatory name and description.

The app references motivating this helper are `daoships-app/src/utils/profileUpdate.ts`, `hooks/useDaoProfile.ts`, and `services/indexer/RecordIndexerService.ts`. The helper carries links, tags and chain ID as well as banner/theme, and implements record omission semantics instead of reproducing unsupported nulls in the app's older helper.

Validation: six new tests in `test/final-profile-review.test.mjs` cover carry-forward, all clear modes, no-change detection, object order, cloning, malformed/accessor inputs, sanitation and merged byte limits. The focused profile/Poster set passed 11 tests; TypeScript build passed.
