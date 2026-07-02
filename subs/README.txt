==============================================================================
  STANDALONE SUBTITLES - FOLDER & NAMING RULES
==============================================================================

Put subtitle files here to have them served to Stremio independently of
Jellyfin. Each title gets its own folder, named by its IMDb id (the "tt..."
number).

Supported file types:  .srt  .vtt  .ass  .ssa


------------------------------------------------------------------------------
  FOLDER STRUCTURE
------------------------------------------------------------------------------

  subs/
  ├── movie/
  │   └── <imdbId>[.<free text>]/
  │       └── <label> <notes>.<lang>.srt
  └── series/
      └── <imdbId>[.<free text>]/
          └── S<season>E<episode>.<label> <notes>.<lang>.srt

  One folder per title, named by its IMDb id. You may add ".<free text>" after
  the id (e.g. the title's name) for your own reference; that text is ignored
  when matching.

  Inside a movie folder, each file is one subtitle for that movie. Inside a
  series folder, each file is named for its episode - S<season>E<episode>, with
  the season and episode numbers zero-padded to two digits (S01E05).


------------------------------------------------------------------------------
  FILENAME RULES
------------------------------------------------------------------------------

  Movie file:   <label> <notes>.<lang>.<ext>
  Series file:  S<season>E<episode>.<label> <notes>.<lang>.<ext>

  lang    The LAST field before the extension. A 2- or 3-letter language code
          (en, eng, fr, fre, ...). Stremio uses this to show the language name.
          Always keep it last, e.g. "...eng.srt". The last field is ALWAYS read
          as the language (see Common Mistakes), so don't drop it. If it is
          missing or unrecognised, a default language is used.

  label   Optional. The field(s) before the language (and, for series, after
          the SxxExx). Use it to tell apart two files for the same title and
          language - for example a well-synced copy versus one that drifts. The
          difference is visible when you hover over the subtitle in the Stremio
          desktop app. For a multi-word label, join the words with "-" or "."
          (a space starts the notes - see below).

  notes   Optional. Anything after the FIRST SPACE is ignored by the addon. Use
          it for a readable title or any reminder to yourself.


------------------------------------------------------------------------------
  EXAMPLE LAYOUT
------------------------------------------------------------------------------

  subs/
  ├── movie/
  │   └── tt0133093.The Matrix/
  │       ├── eng.srt
  │       ├── synced.eng.srt
  │       ├── drift A clearer copy.eng.srt
  │       └── fre.srt
  └── series/
      └── tt0903747.Breaking Bad/
          ├── S01E05.eng.srt
          ├── S01E05.synced.eng.srt
          └── S01E05.drift.eng.srt

  Reading the examples:

  movie/tt0133093.The Matrix/eng.srt
      English. No label.

  movie/tt0133093.The Matrix/synced.eng.srt
      English, label "synced".

  movie/tt0133093.The Matrix/drift A clearer copy.eng.srt
      English, label "drift". "A clearer copy" is after the space, so the addon
      ignores it.

  S01E05.synced.eng.srt / S01E05.drift.eng.srt
      Two English subtitles for the same episode, told apart by their labels
      ("synced" vs "drift").

  A plain "tt0903747/" (or "tt0133093/") folder, without the ".<free text>"
  part, works exactly the same way.


------------------------------------------------------------------------------
  COMMON MISTAKES
------------------------------------------------------------------------------

  Dropping the language (it is always the last field).
      synced.srt
          Here "synced" is read as the language (and falls back to the
          default), NOT as a label.
      Correct:
          synced.eng.srt

  Two files for the same title and language sharing a name.
      Give them different labels so both are unique and you can tell them apart
      on hover, e.g.
          synced.eng.srt
          drift.eng.srt

  More than one folder for the same title.
      Keep a single folder per title (one IMDb id). If two folders match the
      same id, only one is used.

==============================================================================
