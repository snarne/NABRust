// ---------------------------------------------------------------------------
// Rust item ids → shortnames.
//
// A storage monitor reports contents as numeric item ids. The ids are stable
// per item and not derivable, so this is a lookup table, sourced from the
// community item-id dump (Ryan-J-D/Rust-Item-IDs) and spot-checked against
// the ids Rust+ actually reports for wood, stones, metal fragments, high
// quality metal, scrap and sulfur.
//
// An id that isn't here renders as "item #<id>" rather than a guess — a new
// item after a game update should look unknown, not wrong.
// ---------------------------------------------------------------------------

const SHORTNAME: Record<string, string> = {
  '588596902':'ammo.handmade.shell', '-2097376851':'ammo.nailgun.nails', '785728077':'ammo.pistol', '51984655':'ammo.pistol.fire',
  '-1691396643':'ammo.pistol.hv', '-1211166256':'ammo.rifle', '-1321651331':'ammo.rifle.explosive', '1712070256':'ammo.rifle.hv',
  '605467368':'ammo.rifle.incendiary', '-742865266':'ammo.rocket.basic', '1638322904':'ammo.rocket.fire', '-1841918730':'ammo.rocket.hv',
  '-17123659':'ammo.rocket.smoke', '-1685290200':'ammo.shotgun', '-1036635990':'ammo.shotgun.fire', '-727717969':'ammo.shotgun.slug',
  '-1432674913':'antiradpills', '1548091822':'apple', '352130972':'apple.spoiled', '215754713':'arrow.bone',
  '14241751':'arrow.fire', '-1023065463':'arrow.hv', '-1234735557':'arrow.wooden', '794356786':'attire.hide.boots',
  '3222790':'attire.hide.helterneck', '1722154847':'attire.hide.pants', '980333378':'attire.hide.poncho', '-1773144852':'attire.hide.skirt',
  '196700171':'attire.hide.vest', '-324675402':'attire.reindeer.headband', '-2139580305':'autoturret', '-262590403':'axe.salvaged',
  '-2072273936':'bandage', '-1950721390':'barricade.concrete', '1655650836':'barricade.metal', '-559599960':'barricade.sandbags',
  '15388698':'barricade.stone', '866889860':'barricade.wood', '1382263453':'barricade.woodwire', '609049394':'battery.small',
  '1099314009':'bbq', '-1520560807':'bearmeat', '-989755543':'bearmeat.burned', '1873897110':'bearmeat.cooked',
  '-1273339005':'bed', '1931713481':'black.raspberries', '1553078977':'bleach', '1776460938':'blood',
  '-586342290':'blueberries', '-996920608':'blueprintbase', '1746956556':'bone.armor.suit', '1711033574':'bone.club',
  '1719978075':'bone.fragments', '-1000573653':'boots.frog', '613961768':'botabag', '884424049':'bow.compound',
  '1443579727':'bow.hunting', '803222026':'box.repair.bench', '-180129657':'box.wooden', '833533164':'box.wooden.large',
  '850280505':'bucket.helmet', '1424075905':'bucket.water', '1525520776':'building.planner', '1366282552':'burlap.gloves',
  '1877339384':'burlap.headwrap', '602741290':'burlap.shirt', '-761829530':'burlap.shoes', '1992974553':'burlap.trousers',
  '1783512007':'cactusflesh', '1946219319':'campfire', '-700591459':'can.beans', '1655979682':'can.beans.empty',
  '-1941646328':'can.tuna', '-1557377697':'can.tuna.empty', '1121925526':'candycane', '1789825282':'candycaneclub',
  '634478325':'cctv.camera', '1142993169':'ceilinglight', '1104520648':'chainsaw', '1534542921':'chair',
  '-1938052175':'charcoal', '1973684065':'chicken.burned', '-1848736516':'chicken.cooked', '-1440987069':'chicken.raw',
  '-751151717':'chicken.spoiled', '363467698':'chocholate', '-778875547':'clone.corn', '-886280491':'clone.hemp',
  '1898094925':'clone.pumpkin', '-858312878':'cloth', '204391461':'coal', '-803263829':'coffeecan.helmet',
  '1367190888':'corn', '1965232394':'crossbow', '-321733511':'crude.oil', '-97956382':'cupboard.tool',
  '-1903165497':'deer.skull.mask', '-78533081':'deermeat.burned', '-1509851560':'deermeat.cooked', '1422530437':'deermeat.raw',
  '296519935':'diving.fins', '-113413047':'diving.mask', '-2022172587':'diving.tank', '-1101924344':'diving.wetsuit',
  '1409529282':'door.closer', '1390353317':'door.double.hinged.metal', '1221063409':'door.double.hinged.toptier', '-1336109173':'door.double.hinged.wood',
  '-2067472972':'door.hinged.metal', '1353298668':'door.hinged.toptier', '1729120840':'door.hinged.wood', '-1112793865':'door.key',
  '-1519126340':'dropbox', '1401987718':'ducttape', '-1878475007':'explosive.satchel', '1248356124':'explosive.timed',
  '-592016202':'explosives', '798638114':'facialhair.style01', '-1018587433':'fat.animal', '649305914':'female_hairstyle_01',
  '649305917':'female_hairstyle_02', '649305916':'female_hairstyle_03', '649305918':'female_hairstyle_05', '274502203':'femalearmpithair.style01',
  '-1065444793':'femaleeyebrow.style01', '16333305':'femalepubichair.style01', '-1535621066':'fireplace.stone', '1668129151':'fish.cooked',
  '-542577259':'fish.minnows', '989925924':'fish.raw', '-1878764039':'fish.troutsmall', '1569882109':'fishingrod.handmade',
  '559147458':'fishtrap.small', '-1215753368':'flamethrower', '528668503':'flameturret', '304481038':'flare',
  '-196667575':'flashlight.held', '936496778':'floor.grill', '1948067030':'floor.ladder.hatch', '1413014235':'fridge',
  '-2124352573':'fun.guitar', '-1999722522':'furnace', '-1992717673':'furnace.large', '-629028935':'fuse',
  '-691113464':'gates.external.high.stone', '-335089230':'gates.external.high.wood', '479143914':'gears', '999690781':'geiger.counter',
  '-1819763926':'generator.wind.scrap', '-690276911':'gloweyes', '-1899491405':'glue', '-746030907':'granolabar',
  '1840822026':'grenade.beancan', '143803535':'grenade.f1', '-265876753':'gunpowder', '352499047':'guntrap',
  '200773292':'hammer', '-1506397857':'hammer.salvaged', '1675639563':'hat.beenie', '-23994173':'hat.boonie',
  '1714496074':'hat.candle', '-1022661119':'hat.cap', '-1539025626':'hat.miner', '-1478212975':'hat.wolf',
  '-1252059217':'hatchet', '1266491000':'hazmatsuit', '-253079493':'hazmatsuit_scientist', '-1958316066':'hazmatsuit_scientist_peacekeeper',
  '1181207482':'heavy.plate.helmet', '-1102429027':'heavy.plate.jacket', '-1778159885':'heavy.plate.pants', '1751045826':'hoodie',
  '1917703890':'horsemeat.burned', '-1162759543':'horsemeat.cooked', '-1130350864':'horsemeat.raw', '-1982036270':'hq.metal.ore',
  '-682687162':'humanmeat.burned', '1536610005':'humanmeat.cooked', '-1709878924':'humanmeat.raw', '1272768630':'humanmeat.spoiled',
  '-1780802565':'icepick.salvaged', '-1163532624':'jacket', '-48090175':'jacket.snow', '1488979457':'jackhammer',
  '1242482355':'jackolantern.angry', '-1824943010':'jackolantern.happy', '286193827':'jar.pickle', '-484206264':'keycard_blue',
  '37122747':'keycard_green', '-1880870149':'keycard_red', '1814288539':'knife.bone', '-316250604':'ladder.wooden.wall',
  '1658229558':'lantern', '254522515':'largemedkit', '1381010055':'leather', '-2069578888':'lmg.m249',
  '1159991980':'lock.code', '-850982208':'lock.key', '-110921842':'locker', '-1469578201':'longsword',
  '-946369541':'lowgradefuel', '-1966748496':'mace', '-1137865085':'machete', '-586784898':'mailbox',
  '-163828118':'male.facialhair.style02', '-163828117':'male.facialhair.style03', '-163828112':'male.facialhair.style04', '1070894649':'male_hairstyle_01',
  '1070894648':'male_hairstyle_02', '1070894647':'male_hairstyle_03', '1070894646':'male_hairstyle_04', '1070894645':'male_hairstyle_05',
  '181590376':'malearmpithair.style01', '-874975042':'maleeyebrow.style01', '-1190096326':'malepubichair.style01', '696029452':'map',
  '-2012470695':'mask.balaclava', '-702051347':'mask.bandana', '621915341':'meat.boar', '1391703481':'meat.pork.burned',
  '-242084766':'meat.pork.cooked', '-194953424':'metal.facemask', '69511070':'metal.fragments', '-4031221':'metal.ore',
  '1110385766':'metal.plate.torso', '317398316':'metal.refined', '1882709339':'metalblade', '95950017':'metalpipe',
  '-1021495308':'metalspring', '-1130709577':'mining.pumpjack', '1052926200':'mining.quarry', '-1962971928':'mushroom',
  '1414245162':'note', '237239288':'pants', '-1695367501':'pants.shorts', '-1779183908':'paper',
  '-1302129395':'pickaxe', '-75944661':'pistol.eoka', '-852563019':'pistol.m92', '1953903201':'pistol.nailgun',
  '1373971859':'pistol.python', '649912614':'pistol.revolver', '818877484':'pistol.semiauto', '1581210395':'planter.large',
  '1903654061':'planter.small', '-1651220691':'pookie.bear', '-1673693549':'propanetank', '-567909622':'pumpkin',
  '-1861522751':'research.table', '-544317637':'researchpaper', '1545779598':'rifle.ak', '1588298435':'rifle.bolt',
  '-1812555177':'rifle.lr300', '-904863145':'rifle.semiauto', '176787552':'riflebody', '671063303':'riot.helmet',
  '-2002277461':'roadsign.jacket', '1850456855':'roadsign.kilt', '1199391518':'roadsigns', '963906841':'rock',
  '442886268':'rocket.launcher', '1414245522':'rope', '-1985799200':'rug', '-1104881824':'rug.bear',
  '-1978999529':'salvaged.cleaver', '1326180354':'salvaged.sword', '-575483084':'santahat', '177226991':'scarecrow',
  '-932201673':'scrap', '2087678962':'searchlight', '998894949':'seed.corn', '-237809779':'seed.hemp',
  '-1511285251':'seed.pumpkin', '573926264':'semibody', '1234880403':'sewingkit', '-1994909036':'sheetmetal',
  '1950721418':'shelves', '-2025184684':'shirt.collared', '1608640313':'shirt.tanktop', '-1549739227':'shoes.boots',
  '-765183617':'shotgun.double', '795371088':'shotgun.pump', '-41440462':'shotgun.spas12', '-1367281941':'shotgun.waterpipe',
  '-1199897169':'shutter.metal.embrasure.a', '-1199897172':'shutter.metal.embrasure.b', '-1023374709':'shutter.wood.a', '1205607945':'sign.hanging',
  '23352662':'sign.hanging.banner.large', '-1647846966':'sign.hanging.ornate', '-845557339':'sign.pictureframe.landscape', '-1370759135':'sign.pictureframe.portrait',
  '121049755':'sign.pictureframe.tall', '-996185386':'sign.pictureframe.xl', '98508942':'sign.pictureframe.xxl', '2070189026':'sign.pole.banner.large',
  '1521286012':'sign.post.double', '1542290441':'sign.post.single', '-1832422579':'sign.post.town', '826309791':'sign.post.town.roof',
  '-143132326':'sign.wooden.huge', '1153652756':'sign.wooden.large', '-1819233322':'sign.wooden.medium', '-1138208076':'sign.wooden.small',
  '996293980':'skull.human', '2048317869':'skull.wolf', '553887414':'skull_fire_pit', '-1754948969':'sleepingbag',
  '-1293296287':'small.oil.refinery', '-1039528932':'smallwaterbottle', '1796682209':'smg.2', '1318558775':'smg.mp5',
  '-1758372725':'smg.thompson', '1230323789':'smgbody', '-363689972':'snowball', '1629293099':'snowman',
  '1602646136':'spear.stone', '1540934679':'spear.wooden', '-92759291':'spikes.floor', '-1100422738':'spinner.wheel',
  '-369760990':'stash.small', '642482233':'sticks', '-465682601':'stocking.large', '1668858301':'stocking.small',
  '171931394':'stone.pickaxe', '-1583967946':'stonehatchet', '-2099697608':'stones', '-1581843485':'sulfur',
  '-1157596551':'sulfur.ore', '1397052267':'supply.signal', '1975934948':'surveycharge', '1079279582':'syringe.medical',
  '593465182':'table', '-1736356576':'target.reactive', '1523195708':'targeting.computer', '2019042823':'tarp',
  '73681876':'techparts', '-1262185308':'tool.binoculars', '-1316706473':'tool.camera', '795236088':'torch',
  '-582782051':'trap.bear', '-1663759755':'trap.landmine', '223891266':'tshirt', '935692442':'tshirt.long',
  '-1478445584':'tunalight', '198438816':'vending.machine', '99588025':'wall.external.high', '-967648160':'wall.external.high.stone',
  '-1429456799':'wall.frame.cell', '-956706906':'wall.frame.cell.gate', '-1117626326':'wall.frame.fence', '1451568081':'wall.frame.fence.gate',
  '-148794216':'wall.frame.garagedoor', '1516985844':'wall.frame.netting', '-796583652':'wall.frame.shopfront', '-148229307':'wall.frame.shopfront.metal',
  '-819720157':'wall.window.bars.metal', '671706427':'wall.window.bars.toptier', '-1183726687':'wall.window.bars.wood', '-1614955425':'wall.window.glass.reinforced',
  '-463122489':'watchtower.wood', '-1779180711':'water', '-1863559151':'water.barrel', '-1100168350':'water.catcher.large',
  '-132247350':'water.catcher.small', '2114754781':'water.purifier', '-277057363':'water.salt', '-119235651':'waterjug',
  '952603248':'weapon.mod.flashlight', '442289265':'weapon.mod.holosight', '-132516482':'weapon.mod.lasersight', '-1405508498':'weapon.mod.muzzleboost',
  '1478091698':'weapon.mod.muzzlebrake', '-1850571427':'weapon.mod.silencer', '-855748505':'weapon.mod.simplesight', '567235583':'weapon.mod.small.scope',
  '1827479659':'wolfmeat.burned', '813023040':'wolfmeat.cooked', '-395377963':'wolfmeat.raw', '-1167031859':'wolfmeat.spoiled',
  '-151838493':'wood', '-2094954543':'wood.armor.helmet', '418081930':'wood.armor.jacket', '832133926':'wood.armor.pants',
  '1524187186':'workbench1', '-41896755':'workbench2', '-1607980696':'workbench3', '-1667224349':'xmas.decoration.baubels',
  '-209869746':'xmas.decoration.candycanes', '1686524871':'xmas.decoration.gingerbreadmen', '1723747470':'xmas.decoration.lights', '-129230242':'xmas.decoration.pinecone',
  '-1331212963':'xmas.decoration.star', '2106561762':'xmas.decoration.tinsel', '674734128':'xmas.door.garland', '1058261682':'xmas.lightstring',
  '-1622660759':'xmas.present.large', '756517185':'xmas.present.medium', '-722241321':'xmas.present.small', '794443127':'xmas.tree',
  '-1379835144':'xmas.window.garland', '2009734114':'xmasdoorwreath',
}

/** The handful of names players never say as shortnames. */
const FRIENDLY: Record<string, string> = {
  wood: 'wood',
  stones: 'stone',
  'metal.fragments': 'metal frags',
  'metal.refined': 'HQM',
  scrap: 'scrap',
  sulfur: 'sulfur',
  lowgradefuel: 'low grade',
  'explosive.timed': 'C4',
  'ammo.rocket.basic': 'rockets',
  'explosive.satchel': 'satchels',
  'ammo.rifle.explosive': 'explosive 5.56',
}

export function itemShortname(id: number): string | null {
  return SHORTNAME[String(id)] ?? null
}

export function itemName(id: number): string {
  const short = SHORTNAME[String(id)]
  if (!short) return `item #${id}`
  return FRIENDLY[short] ?? short
}

/** Ids for the upkeep resources, so a tool cupboard can be read at a glance. */
export const UPKEEP_ITEMS = {
  wood: -151838493,
  stones: -2099697608,
  'metal.fragments': 69511070,
  'metal.refined': 317398316,
} as const
