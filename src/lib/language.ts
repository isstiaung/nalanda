// Languages (ARCH.md §16 #76): the household's default, every item's own, and what a provider's code means. ISO 639-1,
// two letters, as an item stores it; a provider's three-letter ISO 639-2 code (Open Library's "eng") is mapped here.
// Names are English, for the form's list; the interface-language work (queue 15) may localise them later.

/** [ISO 639-1, ISO 639-2/T, English name] — every 639-1 language, so "any ISO language" means any of these. */
const TABLE: ReadonlyArray<readonly [string, string, string]> = [
  ['aa','aar','Afar'],['ab','abk','Abkhazian'],['af','afr','Afrikaans'],['ak','aka','Akan'],['sq','sqi','Albanian'],['am','amh','Amharic'],
  ['ar','ara','Arabic'],['an','arg','Aragonese'],['hy','hye','Armenian'],['as','asm','Assamese'],['av','ava','Avaric'],['ay','aym','Aymara'],
  ['az','aze','Azerbaijani'],['bm','bam','Bambara'],['ba','bak','Bashkir'],['eu','eus','Basque'],['be','bel','Belarusian'],['bn','ben','Bengali'],
  ['bi','bis','Bislama'],['bs','bos','Bosnian'],['br','bre','Breton'],['bg','bul','Bulgarian'],['my','mya','Burmese'],['ca','cat','Catalan'],
  ['ch','cha','Chamorro'],['ce','che','Chechen'],['ny','nya','Chichewa'],['zh','zho','Chinese'],['cv','chv','Chuvash'],['kw','cor','Cornish'],
  ['co','cos','Corsican'],['cr','cre','Cree'],['hr','hrv','Croatian'],['cs','ces','Czech'],['da','dan','Danish'],['dv','div','Divehi'],
  ['nl','nld','Dutch'],['dz','dzo','Dzongkha'],['en','eng','English'],['eo','epo','Esperanto'],['et','est','Estonian'],['ee','ewe','Ewe'],
  ['fo','fao','Faroese'],['fj','fij','Fijian'],['fi','fin','Finnish'],['fr','fra','French'],['ff','ful','Fulah'],['gl','glg','Galician'],
  ['ka','kat','Georgian'],['de','deu','German'],['el','ell','Greek'],['gn','grn','Guarani'],['gu','guj','Gujarati'],['ht','hat','Haitian'],
  ['ha','hau','Hausa'],['he','heb','Hebrew'],['hz','her','Herero'],['hi','hin','Hindi'],['ho','hmo','Hiri Motu'],['hu','hun','Hungarian'],
  ['ia','ina','Interlingua'],['id','ind','Indonesian'],['ie','ile','Interlingue'],['ga','gle','Irish'],['ig','ibo','Igbo'],['ik','ipk','Inupiaq'],
  ['io','ido','Ido'],['is','isl','Icelandic'],['it','ita','Italian'],['iu','iku','Inuktitut'],['ja','jpn','Japanese'],['jv','jav','Javanese'],
  ['kl','kal','Kalaallisut'],['kn','kan','Kannada'],['kr','kau','Kanuri'],['ks','kas','Kashmiri'],['kk','kaz','Kazakh'],['km','khm','Khmer'],
  ['ki','kik','Kikuyu'],['rw','kin','Kinyarwanda'],['ky','kir','Kyrgyz'],['kv','kom','Komi'],['kg','kon','Kongo'],['ko','kor','Korean'],
  ['ku','kur','Kurdish'],['kj','kua','Kwanyama'],['la','lat','Latin'],['lb','ltz','Luxembourgish'],['lg','lug','Ganda'],['li','lim','Limburgish'],
  ['ln','lin','Lingala'],['lo','lao','Lao'],['lt','lit','Lithuanian'],['lu','lub','Luba-Katanga'],['lv','lav','Latvian'],['gv','glv','Manx'],
  ['mk','mkd','Macedonian'],['mg','mlg','Malagasy'],['ms','msa','Malay'],['ml','mal','Malayalam'],['mt','mlt','Maltese'],['mi','mri','Māori'],
  ['mr','mar','Marathi'],['mh','mah','Marshallese'],['mn','mon','Mongolian'],['na','nau','Nauru'],['nv','nav','Navajo'],['nd','nde','North Ndebele'],
  ['ne','nep','Nepali'],['ng','ndo','Ndonga'],['nb','nob','Norwegian Bokmål'],['nn','nno','Norwegian Nynorsk'],['no','nor','Norwegian'],['ii','iii','Nuosu'],
  ['nr','nbl','South Ndebele'],['oc','oci','Occitan'],['oj','oji','Ojibwe'],['cu','chu','Church Slavonic'],['om','orm','Oromo'],['or','ori','Odia'],
  ['os','oss','Ossetian'],['pa','pan','Punjabi'],['pi','pli','Pali'],['fa','fas','Persian'],['pl','pol','Polish'],['ps','pus','Pashto'],
  ['pt','por','Portuguese'],['qu','que','Quechua'],['rm','roh','Romansh'],['rn','run','Rundi'],['ro','ron','Romanian'],['ru','rus','Russian'],
  ['sa','san','Sanskrit'],['sc','srd','Sardinian'],['sd','snd','Sindhi'],['se','sme','Northern Sami'],['sm','smo','Samoan'],['sg','sag','Sango'],
  ['sr','srp','Serbian'],['gd','gla','Scottish Gaelic'],['sn','sna','Shona'],['si','sin','Sinhala'],['sk','slk','Slovak'],['sl','slv','Slovenian'],
  ['so','som','Somali'],['st','sot','Southern Sotho'],['es','spa','Spanish'],['su','sun','Sundanese'],['sw','swa','Swahili'],['ss','ssw','Swati'],
  ['sv','swe','Swedish'],['ta','tam','Tamil'],['te','tel','Telugu'],['tg','tgk','Tajik'],['th','tha','Thai'],['ti','tir','Tigrinya'],
  ['bo','bod','Tibetan'],['tk','tuk','Turkmen'],['tl','tgl','Tagalog'],['tn','tsn','Tswana'],['to','ton','Tongan'],['tr','tur','Turkish'],
  ['ts','tso','Tsonga'],['tt','tat','Tatar'],['tw','twi','Twi'],['ty','tah','Tahitian'],['ug','uig','Uyghur'],['uk','ukr','Ukrainian'],
  ['ur','urd','Urdu'],['uz','uzb','Uzbek'],['ve','ven','Venda'],['vi','vie','Vietnamese'],['vo','vol','Volapük'],['wa','wln','Walloon'],
  ['cy','cym','Welsh'],['wo','wol','Wolof'],['fy','fry','Western Frisian'],['xh','xho','Xhosa'],['yi','yid','Yiddish'],['yo','yor','Yoruba'],
  ['za','zha','Zhuang'],['zu','zul','Zulu'],
];

/** Open Library's codes are ISO 639-2/B where B and T differ: these are the B codes for the languages above that have one. */
const BIBLIOGRAPHIC: Record<string, string> = {
  alb: 'sq', arm: 'hy', baq: 'eu', bur: 'my', chi: 'zh', cze: 'cs', dut: 'nl', fre: 'fr', geo: 'ka', ger: 'de', gre: 'el', ice: 'is',
  mac: 'mk', mao: 'mi', may: 'ms', per: 'fa', rum: 'ro', slo: 'sk', tib: 'bo', wel: 'cy',
};

const BY_1 = new Map(TABLE.map((t) => [t[0], t]));
const BY_2 = new Map(TABLE.map((t) => [t[1], t[0]]));

/** The household's language until an admin picks one. */
export const DEFAULT_LANGUAGE = 'en';

/** Every language, for a select: code and English name, by name. */
export const LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [...TABLE]
  .map((t) => ({ code: t[0], name: t[2] }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

export const isLanguageCode = (code: unknown): code is string => typeof code === 'string' && BY_1.has(code);

export const languageName = (code: string): string => BY_1.get(code)?.[2] ?? code;

/**
 * A provider's language as a code of ours, or null: Google Books sends "en" or "en-US", Open Library "eng" (639-2/B),
 * a file might say "English". Anything else is none, and the item takes the household's.
 */
export function languageFromProvider(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  const two = t.slice(0, 2);
  if (/^[a-z]{2}([-_]|$)/.test(t) && BY_1.has(two)) return two;
  if (/^[a-z]{3}$/.test(t)) return BIBLIOGRAPHIC[t] ?? BY_2.get(t) ?? null;
  const named = TABLE.find((x) => x[2].toLowerCase() === t);
  return named ? named[0] : null;
}
