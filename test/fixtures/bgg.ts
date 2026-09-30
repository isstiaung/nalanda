// BoardGameGeek XML API2 answers, in the shape `thing?id=…&stats=1` and `search?type=boardgame` return them
// (boardgamegeek.com/wiki/page/BGG_XML_API2): the elements, attributes and nesting BGG sends, with the long parts —
// the player-count polls, most rank rows, the description — trimmed. Nothing Nalanda reads was changed. Written out by
// hand in that shape rather than captured, since BGG answers only a registered token; tests replay them through
// test/fetch-mock.ts and nothing here calls BGG.

/** `search?type=boardgame&query=Catan`, cut to its first two hits. */
export const SEARCH_CATAN = `<?xml version="1.0" encoding="utf-8"?><items total="2" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item type="boardgame" id="13">
    <name type="primary" value="CATAN"/>
    <yearpublished value="1995" />
  </item>
  <item type="boardgame" id="278">
    <name type="primary" value="Catan Card Game"/>
    <yearpublished value="1996" />
  </item>
</items>`;

/** `thing?id=13&stats=1`: CATAN, weighed by thousands of BGG users at 2.2857. */
export const THING_13 = `<?xml version="1.0" encoding="utf-8"?><items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item type="boardgame" id="13">
    <thumbnail>https://cf.geekdo-images.com/W3Bsga_uLP9kO91gZ7H8yw__thumb/img/pic2419375.jpg</thumbnail>
    <image>https://cf.geekdo-images.com/W3Bsga_uLP9kO91gZ7H8yw__original/img/pic2419375.jpg</image>
    <name type="primary" sortindex="1" value="CATAN" />
    <name type="alternate" sortindex="5" value="The Settlers of Catan" />
    <description>In CATAN (formerly The Settlers of Catan), players try to be the dominant force on the island of Catan by building settlements, cities, and roads.&amp;#10;&amp;#10;Trade, build and settle.</description>
    <yearpublished value="1995" />
    <minplayers value="3" />
    <maxplayers value="4" />
    <poll name="suggested_numplayers" title="User Suggested Number of Players" totalvotes="2395">
      <results numplayers="3">
        <result value="Best" numvotes="782" />
        <result value="Recommended" numvotes="1170" />
        <result value="Not Recommended" numvotes="111" />
      </results>
      <results numplayers="4">
        <result value="Best" numvotes="1738" />
        <result value="Recommended" numvotes="480" />
        <result value="Not Recommended" numvotes="41" />
      </results>
    </poll>
    <playingtime value="120" />
    <minplaytime value="60" />
    <maxplaytime value="120" />
    <minage value="10" />
    <link type="boardgamecategory" id="1021" value="Economic" />
    <link type="boardgamecategory" id="1026" value="Negotiation" />
    <link type="boardgamemechanic" id="2072" value="Dice Rolling" />
    <link type="boardgamedesigner" id="11" value="Klaus Teuber" />
    <link type="boardgameartist" id="12" value="Volkan Baga" />
    <link type="boardgamepublisher" id="37" value="KOSMOS" />
    <statistics page="1">
      <ratings>
        <usersrated value="129012" />
        <average value="7.09457" />
        <bayesaverage value="6.91376" />
        <ranks>
          <rank type="subtype" id="1" name="boardgame" friendlyname="Board Game Rank" value="541" bayesaverage="6.91376" />
          <rank type="family" id="5499" name="familygames" friendlyname="Family Game Rank" value="116" bayesaverage="6.83187" />
        </ranks>
        <stddev value="1.49108" />
        <median value="0" />
        <owned value="205391" />
        <trading value="2340" />
        <wanting value="512" />
        <wishing value="4921" />
        <numcomments value="21047" />
        <numweights value="8203" />
        <averageweight value="2.2857" />
      </ratings>
    </statistics>
  </item>
</items>`;

/** `thing?id=278&stats=1`: a game no one has weighed yet — BGG answers averageweight 0, which is no weight. */
export const THING_278_UNWEIGHED = `<?xml version="1.0" encoding="utf-8"?><items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item type="boardgame" id="278">
    <thumbnail>https://cf.geekdo-images.com/catan-card__thumb/img/pic278.jpg</thumbnail>
    <image>https://cf.geekdo-images.com/catan-card__original/img/pic278.jpg</image>
    <name type="primary" sortindex="1" value="Catan Card Game" />
    <description>The two-player card game of Catan.</description>
    <yearpublished value="1996" />
    <minplayers value="2" />
    <maxplayers value="2" />
    <playingtime value="90" />
    <minplaytime value="90" />
    <maxplaytime value="90" />
    <link type="boardgamedesigner" id="11" value="Klaus Teuber" />
    <statistics page="1">
      <ratings>
        <usersrated value="0" />
        <average value="0" />
        <bayesaverage value="0" />
        <ranks>
          <rank type="subtype" id="1" name="boardgame" friendlyname="Board Game Rank" value="Not Ranked" bayesaverage="Not Ranked" />
        </ranks>
        <numweights value="0" />
        <averageweight value="0" />
      </ratings>
    </statistics>
  </item>
</items>`;

/** CATAN and the card game in one `thing` answer, as the Add page's search asks for its hits. */
export const THING_13_278 = THING_13.replace(
  /<\/items>$/,
  THING_278_UNWEIGHED.slice(THING_278_UNWEIGHED.indexOf('<item '), THING_278_UNWEIGHED.lastIndexOf('</items>')) + '</items>',
);

/** `thing?id=999999999&stats=1`: an id BGG doesn't have — a 200 with no <item>. */
export const THING_NONE = `<?xml version="1.0" encoding="utf-8"?><items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
</items>`;
