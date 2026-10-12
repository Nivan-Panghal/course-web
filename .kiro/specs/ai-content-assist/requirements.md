# Requirements Document

## Introduction

The AI Content Assist feature integrates an AI writing assistant into four creator editing surfaces in the platform: the workshop settings page (editing an existing workshop), the create workshop page (new workshop creation), the course settings page (editing an existing course), and the create course page (new course creation). Creators can invoke AI generation on individual text fields in editing contexts, or trigger a bulk-fill flow on creation pages where they describe their offering in natural language and the AI populates all text fields at once. AI-generated content appears inline in the same field as a draft, is never auto-saved, and requires the creator to explicitly save before changes persist. A usage cap limits the total number of AI generation calls per creator account to control infrastructure cost.

---

## Glossary

- **AI_Assist**: The AI writing assistant feature described in this document.
- **Creator**: An authenticated platform user who owns and edits workshops and courses.
- **Content_Field**: A text input or textarea on an editing page that holds narrative content (e.g. description, tagline, what_you_will_learn, target_audience, requirements, faq, about_creator). Excludes structural/data fields such as price, start date, capacity, and zoom link.
- **Settings_Page**: The workshop settings page (`/dashboard/workshops/[id]`) or course settings page (`/dashboard/courses/[id]`) used to edit an existing offering.
- **Creation_Page**: The create workshop page (`/dashboard/workshops/create`) or create course page (`/dashboard/courses/create`) used to create a new offering.
- **Inline_Draft**: An AI-generated text value placed directly into a Content_Field's input state on the client without being written to the database.
- **Bulk_Fill**: A Creation_Page flow where AI populates all eligible Content_Fields at once from a natural language description provided by the Creator.
- **Clarifying_Question**: A follow-up question the AI_Assist asks the Creator when the available context is too sparse to generate useful content.
- **Reprompt**: A Creator-authored message that gives the AI_Assist additional direction after an initial generation it found unsatisfactory.
- **Regenerate**: An explicit creator action that triggers a new AI generation for the same field, replacing the previous Inline_Draft.
- **Usage_Cap**: The maximum number of AI generation calls a Creator account may make within a rolling calendar month.
- **AI_Assist_Route**: The Next.js API route dedicated to AI content generation for creator editing (distinct from the existing `/api/ai/ask` student doubt route).
- **Context_Payload**: The set of already-filled Content_Fields on the page that are passed to the AI_Assist_Route with each generation request, giving the AI context about the offering.

---

## Requirements

### Requirement 1: Per-Field AI Assist on Settings Pages

**User Story:** As a Creator editing an existing workshop or course, I want a "Write with AI" button next to each text Content_Field, so that I can get an AI-generated suggestion for that field without leaving the page.

#### Acceptance Criteria

1. THE Settings_Page SHALL render a "Write with AI" trigger button adjacent to each Content_Field that is eligible for AI assistance.
2. THE Settings_Page SHALL NOT render a "Write with AI" trigger button adjacent to structural or data fields (price, start date, capacity, zoom link, slug, co-instructors, policy documents, testimonials, theme, font, custom sections).
3. WHEN a Creator activates the "Write with AI" button on a Content_Field, THE AI_Assist SHALL generate a suggestion for that specific field using the Context_Payload from other already-filled Content_Fields on the page.
4. WHEN the AI_Assist generates a suggestion, THE Settings_Page SHALL place the suggestion as an Inline_Draft directly into the target Content_Field's input state.
5. WHILE an Inline_Draft is present in a Content_Field, THE Settings_Page SHALL display "Regenerate" and "Reprompt" actions alongside that field.
6. WHEN a Creator activates the Regenerate action on a Content_Field that holds an Inline_Draft, THE AI_Assist SHALL generate a new suggestion for that field, replacing the previous Inline_Draft.
7. THE Settings_Page SHALL allow the Creator to freely read, edit, or delete the Inline_Draft text inside the Content_Field at any time.

---

### Requirement 2: Draft Isolation — No Auto-Save

**User Story:** As a Creator, I want AI-generated content to remain a local draft until I explicitly save, so that my published content is never modified without my intent.

#### Acceptance Criteria

1. THE AI_Assist SHALL write generated content only to the client-side field state (Inline_Draft); it SHALL NOT write to the Supabase database.
2. THE Settings_Page SHALL persist a Content_Field's value to the database only when the Creator explicitly triggers the existing Save action for that field or the page-level Save.
3. WHEN a Creator navigates away from the page without saving, THE Settings_Page SHALL discard all unsaved Inline_Drafts without writing them to the database.
4. IF the Creator reloads or closes the page before saving, THEN THE Settings_Page SHALL restore the previously saved database values on next load, not the discarded Inline_Drafts.

---

### Requirement 3: Regenerate Action

**User Story:** As a Creator, I want to regenerate an AI suggestion for a field if I don't like the initial result, so that I can get a different version without writing anything myself.

#### Acceptance Criteria

1. WHEN a Creator activates the Regenerate action on a Content_Field, THE AI_Assist SHALL send a new generation request for that field, using the current Context_Payload.
2. WHILE the new generation request is in flight, THE Settings_Page SHALL keep the existing Inline_Draft visible and editable in the Content_Field; it SHALL NOT clear or replace the field until the new suggestion has fully arrived.
3. WHEN a new generation completes, THE Settings_Page SHALL replace the existing Inline_Draft in the target Content_Field with the new suggestion atomically — the transition from old to new SHALL occur in a single update with no intermediate empty state visible to the Creator.
4. WHEN a Creator activates Regenerate, THE AI_Assist SHALL count the action against the Creator's Usage_Cap as one generation call.

---

### Requirement 4: Reprompt Option

**User Story:** As a Creator, I want to explain what I didn't like about an AI suggestion and have the AI try again with my guidance, so that I get content closer to my intent without starting from scratch.

#### Acceptance Criteria

1. WHILE an Inline_Draft is present in a Content_Field, THE Settings_Page SHALL provide a Reprompt input where the Creator can enter free-text feedback.
2. WHEN a Creator submits a Reprompt, THE AI_Assist SHALL generate a new suggestion for that Content_Field using both the original Context_Payload and the Creator's reprompt text.
3. WHEN a Reprompt generation completes, THE Settings_Page SHALL replace the existing Inline_Draft in the target Content_Field with the new suggestion.
4. WHEN a Creator submits a Reprompt, THE AI_Assist SHALL count the action against the Creator's Usage_Cap as one generation call.

---

### Requirement 5: Smart Context Detection

**User Story:** As a Creator, I want the AI to ask me clarifying questions only when I haven't given it enough information, so that it generates directly when context is sufficient and only pauses to ask when genuinely needed.

#### Acceptance Criteria

1. WHEN a Creator activates "Write with AI" on a Content_Field, THE AI_Assist SHALL evaluate the completeness of the Context_Payload using the number and length of already-filled Content_Fields on the page.
2. WHEN the Context_Payload contains sufficient detail (at least 3 Content_Fields filled with a combined word count of 30 or more words), THE AI_Assist SHALL generate the suggestion directly without asking Clarifying_Questions.
3. WHEN the Context_Payload is sparse (fewer than 3 Content_Fields filled or combined word count below 30 words), THE AI_Assist SHALL present 1 to 3 targeted Clarifying_Questions before generating.
4. WHEN Clarifying_Questions are presented, THE Settings_Page SHALL display them inline above the target Content_Field and allow the Creator to answer or skip each question.
5. WHEN the Creator submits answers to Clarifying_Questions or skips all of them, THE AI_Assist SHALL proceed to generate the suggestion using both the Context_Payload and the Creator's answers.

---

### Requirement 6: Creator Usage Cap

**User Story:** As the platform operator, I want each Creator's AI generation calls capped per calendar month, so that AI infrastructure costs remain bounded and predictable.

#### Acceptance Criteria

1. THE AI_Assist_Route SHALL enforce a maximum of 50 AI generation calls per Creator account per rolling calendar month.
2. WHEN a Creator's generation call count reaches the Usage_Cap, THE AI_Assist_Route SHALL reject further generation requests with an HTTP 429 response and a human-readable explanation.
3. THE Settings_Page SHALL display the Creator's remaining monthly AI generations count in the AI Assist UI.
4. WHEN a Creator is at 0 remaining generations, THE Settings_Page SHALL disable all "Write with AI" and Regenerate triggers and display a message indicating the monthly limit has been reached.
5. THE AI_Assist_Route SHALL record each generation call in the database against the Creator's user ID and the UTC timestamp of the call.
6. WHEN a new calendar month begins (UTC), THE AI_Assist_Route SHALL treat the Creator's usage count as reset to 0 for the purposes of cap enforcement.

---

### Requirement 7: Bulk Fill on Creation Pages

**User Story:** As a Creator starting a new workshop or course, I want to describe my offering in plain language and have the AI fill all text fields at once, so that I can get a fully drafted page without filling out each field individually.

#### Acceptance Criteria

1. THE Creation_Page SHALL provide a "Write with AI" entry point that opens a natural language description input for the Creator.
2. WHEN a Creator submits a natural language description, THE AI_Assist SHALL evaluate whether the description contains sufficient detail to infer all major Content_Fields.
3. WHEN the description is sufficiently detailed (covers title concept, audience, and at least one learning outcome), THE AI_Assist SHALL generate content for all eligible Content_Fields and place each as an Inline_Draft without asking Clarifying_Questions.
4. WHEN the description is insufficient, THE AI_Assist SHALL ask 1 to 3 Clarifying_Questions before generating.
5. WHEN the AI_Assist completes a Bulk_Fill generation, THE Creation_Page SHALL populate each eligible Content_Field with its corresponding Inline_Draft, preserving any fields the Creator had already manually filled.
6. WHEN the AI_Assist completes a Bulk_Fill generation, THE Creation_Page SHALL display a confirmation prompt that lists any content areas the AI could not confidently generate, asking the Creator if they want to add more detail or proceed.
7. WHEN a Creator chooses to add more detail after the Bulk_Fill confirmation, THE AI_Assist SHALL accept the additional detail as a Reprompt and regenerate all empty Content_Fields.
8. WHEN a Creator proceeds after the Bulk_Fill confirmation, THE Creation_Page SHALL retain all Inline_Drafts for the Creator to review and edit before submitting the form.
9. WHEN a Bulk_Fill generation completes, THE AI_Assist SHALL count the action as one generation call against the Creator's Usage_Cap.

---

### Requirement 8: AI Assist API Route

**User Story:** As a developer, I want a dedicated AI Assist API route for creator content generation, so that creator-facing generation is isolated from the student doubt assistant and can have its own auth, quota, and prompt logic.

#### Acceptance Criteria

1. THE AI_Assist_Route SHALL be a new Next.js POST route separate from `/api/ai/ask`.
2. WHEN a request arrives at the AI_Assist_Route, THE AI_Assist_Route SHALL authenticate the caller as a logged-in Creator using Supabase session auth.
3. IF the request is not authenticated, THEN THE AI_Assist_Route SHALL return an HTTP 401 response.
4. THE AI_Assist_Route SHALL accept a JSON body containing: the target field name, the Context_Payload, the generation mode (single-field or bulk), and an optional reprompt string.
5. THE AI_Assist_Route SHALL use the same Gemini-first, DeepSeek-fallback provider pattern already used in the `/api/ai/ask` route.
6. WHEN a generation request succeeds, THE AI_Assist_Route SHALL return the generated content as a JSON response containing the field name(s) and generated text value(s).
7. IF both AI providers fail, THEN THE AI_Assist_Route SHALL return an HTTP 502 response with a user-readable error message.

---

### Requirement 9: Generation Loading State

**User Story:** As a Creator, I want clear visual feedback while the AI is generating content, so that I know the system is working and I don't activate it a second time by mistake.

#### Acceptance Criteria

1. WHEN an AI generation request is in flight, THE Settings_Page SHALL display a loading indicator in place of the "Write with AI" button for the relevant Content_Field.
2. WHILE an AI generation request is in flight, THE Settings_Page SHALL disable all other "Write with AI" and Regenerate triggers on the same page.
3. WHEN an AI generation request completes or fails, THE Settings_Page SHALL re-enable all "Write with AI" and Regenerate triggers.
4. IF an AI generation request fails, THEN THE Settings_Page SHALL display an inline error message adjacent to the relevant Content_Field and restore the field's previous value.

---

### Requirement 10: Creator Content Ownership

**User Story:** As a Creator, I want full control over any AI-generated text before it is published, so that my content accurately represents my offering and voice.

#### Acceptance Criteria

1. THE Settings_Page SHALL allow the Creator to edit the Inline_Draft text directly within the Content_Field at any time before saving.
2. THE Settings_Page SHALL allow the Creator to discard an Inline_Draft by clearing the Content_Field, restoring the previously saved value.
3. THE AI_Assist SHALL NOT auto-publish or auto-submit any Content_Field value; all persistence requires an explicit Creator action.
4. THE AI_Assist_Route SHALL NOT store the text of generated suggestions in the database; only the usage count metadata SHALL be stored.
