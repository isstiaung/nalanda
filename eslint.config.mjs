// The static half of the accessibility audit (ARCH.md §18, §16 #50). Only accessibility rules are on — jsx-a11y's,
// and two no-restricted-syntax selectors that say what jsx-a11y can't in hono/jsx (below) — no stylistic or
// general lint rules, so `npm run lint` fails for an accessibility reason or not at all.
// The runtime half, axe-core in a real browser, is scripts/a11y.mjs (`npm run a11y`).
//
// Parser: the repo's TypeScript is 7 (the native compiler), which has no JavaScript API, and typescript-eslint
// requires `typescript` < 6.1 as a peer — npm can't give a peer a different version from the root's. Babel's
// parser reads TSX syntax on its own (no type information is needed: these rules only look at JSX), so it does
// the parsing here, with the `typescript` and `jsx` syntax plugins and no Babel config file or transform.
import babelParser from '@babel/eslint-parser';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default [
  {
    files: ['src/**/*.tsx'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins: ['typescript', 'jsx'] } },
      },
    },
    plugins: { 'jsx-a11y': jsxA11y },
    // hono/jsx writes HTML's own attribute names. jsx-ast-utils already matches props case-insensitively, so
    // `tabindex`, `onclick` and `autocomplete` read as tabIndex, onClick and autoComplete; `for` is a different
    // word from `htmlFor`, and this setting teaches the label rules it.
    settings: {
      'jsx-a11y': {
        attributes: { for: ['for', 'htmlFor'] },
        // components that render one native control, so a <label> wrapping them is associated
        components: { RatingSelect: 'select' },
      },
    },
    rules: {
      // `strict`, not `recommended`: the app has no widgets built from divs (no role=listbox on a <ul>, no
      // tabindex on a panel), so recommended's allowances for them would only hide a regression.
      ...jsxA11y.flatConfigs.strict.rules,
      // Off in both presets; on here because they catch real regressions in server-rendered HTML.
      'jsx-a11y/anchor-ambiguous-text': 'error', // "click here", "more", "link"
      'jsx-a11y/lang': 'error', // a valid lang= value (the layout's, and the Devanagari brand's lang="sa")
      'jsx-a11y/no-aria-hidden-on-focusable': 'error',
      'jsx-a11y/prefer-tag-over-role': 'error',
      // label-has-associated-control: every label here wraps its control; `either` also accepts for=.
      'jsx-a11y/label-has-associated-control': ['error', { assert: 'either', depth: 3, controlComponents: ['RatingSelect'] }],
      'no-restricted-syntax': [
        'error',
        // no-autofocus compares the prop name exactly ("React only recognizes autoFocus"), so hono/jsx's lowercase
        // `autofocus` walks straight past it. The same check, in the spelling this codebase writes; the few pages
        // that are one field (log in, setup, search) keep theirs with a reason beside it.
        {
          selector: "JSXAttribute[name.name='autofocus']",
          message: 'jsx-a11y/no-autofocus in hono/jsx spelling: autofocus carries a screen reader past everything before the field.',
        },
        // jsx-a11y knows onClick makes an element interactive but not hx-get/hx-post, which do the same through
        // htmx: on a <div> or a <tr> they make something a mouse can use and a keyboard can't reach. They go on
        // forms, buttons and links only (§18). (This sees attributes written out; htmxTo()'s spread lands on forms.)
        {
          selector:
            "JSXOpeningElement[name.name=/^(div|span|p|li|ul|ol|tr|td|th|table|tbody|section|article|header|footer|aside|main|nav|img|strong|small|label|dd|dt)$/] > JSXAttribute[name.name=/^hx-(get|post|put|patch|delete)$/]",
          message: 'hx-get/hx-post belong on a form, button or link, which a keyboard can reach (ARCH.md §18).',
        },
      ],
    },
  },
];
