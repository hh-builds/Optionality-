-- =====================================================================
--  Future Funded — migration 003: admin v2
--
--  Run this ONCE in Supabase → SQL Editor, after analytics.sql and
--  002-install-tracking.sql. Safe to re-run.
--
--  What it adds
--    1. Where people are, from the browser's own timezone — no IP, no
--       third-party geolocation service, nothing new leaves the browser
--       except a string like "Europe/London".
--    2. An honest plan state. "Complete" was driven by an event that only
--       fired if somebody edited BOTH planners in a single sitting, so most
--       people with a perfectly good saved plan read as Incomplete forever.
--       It is now derived from what is actually stored against the account.
--    3. A read-only plan viewer for support and debugging, with every view
--       written to an audit table.
--    4. A "hide my own activity" switch, so Harry's own devices can be taken
--       out of every figure on the page.
--
--  ⚠️ SIGNATURES CHANGE. Adding a defaulted argument with CREATE OR REPLACE
--  makes a second OVERLOAD rather than replacing the function, and PostgREST
--  then cannot decide which one a request means. Every changed function is
--  therefore DROPPED first, at the top, before anything is recreated.
-- =====================================================================

drop function if exists public.admin_overview();
drop function if exists public.admin_funnel(text, text);
drop function if exists public.admin_features(text, text);
drop function if exists public.admin_installs(text, text);
drop function if exists public.admin_trend(text);
drop function if exists public.admin_users(text, text, text, text, int, int);


-- ---------------------------------------------------------------------
-- 1. REFERENCE DATA — IANA timezone → ISO country, and country names
--
--    Both are static reference tables straight out of the tz database
--    (zone.tab) and ISO 3166. They hold no personal data at all; they are
--    read only through the SECURITY DEFINER functions below, so RLS is on
--    with no policy.
-- ---------------------------------------------------------------------
create table if not exists public.tz_countries (
  zone    text primary key,
  country char(2) not null
);
create table if not exists public.iso_countries (
  code char(2) primary key,
  name text    not null
);
alter table public.tz_countries enable row level security;
alter table public.iso_countries enable row level security;

insert into public.tz_countries (zone, country) values
  ('Africa/Abidjan','CI'),
  ('Africa/Accra','GH'),
  ('Africa/Addis_Ababa','ET'),
  ('Africa/Algiers','DZ'),
  ('Africa/Asmara','ER'),
  ('Africa/Asmera','ER'),
  ('Africa/Bamako','ML'),
  ('Africa/Bangui','CF'),
  ('Africa/Banjul','GM'),
  ('Africa/Bissau','GW'),
  ('Africa/Blantyre','MW'),
  ('Africa/Brazzaville','CG'),
  ('Africa/Bujumbura','BI'),
  ('Africa/Cairo','EG'),
  ('Africa/Casablanca','MA'),
  ('Africa/Ceuta','ES'),
  ('Africa/Conakry','GN'),
  ('Africa/Dakar','SN'),
  ('Africa/Dar_es_Salaam','TZ'),
  ('Africa/Djibouti','DJ'),
  ('Africa/Douala','CM'),
  ('Africa/El_Aaiun','EH'),
  ('Africa/Freetown','SL'),
  ('Africa/Gaborone','BW'),
  ('Africa/Harare','ZW'),
  ('Africa/Johannesburg','ZA'),
  ('Africa/Juba','SS'),
  ('Africa/Kampala','UG'),
  ('Africa/Khartoum','SD'),
  ('Africa/Kigali','RW'),
  ('Africa/Kinshasa','CD'),
  ('Africa/Lagos','NG'),
  ('Africa/Libreville','GA'),
  ('Africa/Lome','TG'),
  ('Africa/Luanda','AO'),
  ('Africa/Lubumbashi','CD'),
  ('Africa/Lusaka','ZM'),
  ('Africa/Malabo','GQ'),
  ('Africa/Maputo','MZ'),
  ('Africa/Maseru','LS'),
  ('Africa/Mbabane','SZ'),
  ('Africa/Mogadishu','SO'),
  ('Africa/Monrovia','LR'),
  ('Africa/Nairobi','KE'),
  ('Africa/Ndjamena','TD'),
  ('Africa/Niamey','NE'),
  ('Africa/Nouakchott','MR'),
  ('Africa/Ouagadougou','BF'),
  ('Africa/Porto-Novo','BJ'),
  ('Africa/Sao_Tome','ST'),
  ('Africa/Timbuktu','ML'),
  ('Africa/Tripoli','LY'),
  ('Africa/Tunis','TN'),
  ('Africa/Windhoek','NA'),
  ('America/Adak','US'),
  ('America/Anchorage','US'),
  ('America/Anguilla','AI'),
  ('America/Antigua','AG'),
  ('America/Araguaina','BR'),
  ('America/Argentina/Buenos_Aires','AR'),
  ('America/Argentina/Catamarca','AR'),
  ('America/Argentina/Cordoba','AR'),
  ('America/Argentina/Jujuy','AR'),
  ('America/Argentina/La_Rioja','AR'),
  ('America/Argentina/Mendoza','AR'),
  ('America/Argentina/Rio_Gallegos','AR'),
  ('America/Argentina/Salta','AR'),
  ('America/Argentina/San_Juan','AR'),
  ('America/Argentina/San_Luis','AR'),
  ('America/Argentina/Tucuman','AR'),
  ('America/Argentina/Ushuaia','AR'),
  ('America/Aruba','AW'),
  ('America/Asuncion','PY'),
  ('America/Atikokan','CA'),
  ('America/Atka','US'),
  ('America/Bahia','BR'),
  ('America/Bahia_Banderas','MX'),
  ('America/Barbados','BB'),
  ('America/Belem','BR'),
  ('America/Belize','BZ'),
  ('America/Blanc-Sablon','CA'),
  ('America/Boa_Vista','BR'),
  ('America/Bogota','CO'),
  ('America/Boise','US'),
  ('America/Buenos_Aires','AR'),
  ('America/Cambridge_Bay','CA'),
  ('America/Campo_Grande','BR'),
  ('America/Cancun','MX'),
  ('America/Caracas','VE'),
  ('America/Catamarca','AR'),
  ('America/Cayenne','GF'),
  ('America/Cayman','KY'),
  ('America/Chicago','US'),
  ('America/Chihuahua','MX'),
  ('America/Ciudad_Juarez','MX'),
  ('America/Coral_Harbour','CA'),
  ('America/Cordoba','AR'),
  ('America/Costa_Rica','CR'),
  ('America/Coyhaique','CL'),
  ('America/Creston','CA'),
  ('America/Cuiaba','BR'),
  ('America/Curacao','CW'),
  ('America/Danmarkshavn','GL'),
  ('America/Dawson','CA'),
  ('America/Dawson_Creek','CA'),
  ('America/Denver','US'),
  ('America/Detroit','US'),
  ('America/Dominica','DM'),
  ('America/Edmonton','CA'),
  ('America/Eirunepe','BR'),
  ('America/El_Salvador','SV'),
  ('America/Ensenada','MX'),
  ('America/Fort_Nelson','CA'),
  ('America/Fort_Wayne','US'),
  ('America/Fortaleza','BR'),
  ('America/Glace_Bay','CA'),
  ('America/Godthab','GL'),
  ('America/Goose_Bay','CA'),
  ('America/Grand_Turk','TC'),
  ('America/Grenada','GD'),
  ('America/Guadeloupe','GP'),
  ('America/Guatemala','GT'),
  ('America/Guayaquil','EC'),
  ('America/Guyana','GY'),
  ('America/Halifax','CA'),
  ('America/Havana','CU'),
  ('America/Hermosillo','MX'),
  ('America/Indiana/Indianapolis','US'),
  ('America/Indiana/Knox','US'),
  ('America/Indiana/Marengo','US'),
  ('America/Indiana/Petersburg','US'),
  ('America/Indiana/Tell_City','US'),
  ('America/Indiana/Vevay','US'),
  ('America/Indiana/Vincennes','US'),
  ('America/Indiana/Winamac','US'),
  ('America/Indianapolis','US'),
  ('America/Inuvik','CA'),
  ('America/Iqaluit','CA'),
  ('America/Jamaica','JM'),
  ('America/Jujuy','AR'),
  ('America/Juneau','US'),
  ('America/Kentucky/Louisville','US'),
  ('America/Kentucky/Monticello','US'),
  ('America/Knox_IN','US'),
  ('America/Kralendijk','BQ'),
  ('America/La_Paz','BO'),
  ('America/Lima','PE'),
  ('America/Los_Angeles','US'),
  ('America/Louisville','US'),
  ('America/Lower_Princes','SX'),
  ('America/Maceio','BR'),
  ('America/Managua','NI'),
  ('America/Manaus','BR'),
  ('America/Marigot','MF'),
  ('America/Martinique','MQ'),
  ('America/Matamoros','MX'),
  ('America/Mazatlan','MX'),
  ('America/Mendoza','AR'),
  ('America/Menominee','US'),
  ('America/Merida','MX'),
  ('America/Metlakatla','US'),
  ('America/Mexico_City','MX'),
  ('America/Miquelon','PM'),
  ('America/Moncton','CA'),
  ('America/Monterrey','MX'),
  ('America/Montevideo','UY'),
  ('America/Montreal','CA'),
  ('America/Montserrat','MS'),
  ('America/Nassau','BS'),
  ('America/New_York','US'),
  ('America/Nipigon','CA'),
  ('America/Nome','US'),
  ('America/Noronha','BR'),
  ('America/North_Dakota/Beulah','US'),
  ('America/North_Dakota/Center','US'),
  ('America/North_Dakota/New_Salem','US'),
  ('America/Nuuk','GL'),
  ('America/Ojinaga','MX'),
  ('America/Panama','PA'),
  ('America/Pangnirtung','CA'),
  ('America/Paramaribo','SR'),
  ('America/Phoenix','US'),
  ('America/Port-au-Prince','HT'),
  ('America/Port_of_Spain','TT'),
  ('America/Porto_Acre','BR'),
  ('America/Porto_Velho','BR'),
  ('America/Puerto_Rico','PR'),
  ('America/Punta_Arenas','CL'),
  ('America/Rainy_River','CA'),
  ('America/Rankin_Inlet','CA'),
  ('America/Recife','BR'),
  ('America/Regina','CA'),
  ('America/Resolute','CA'),
  ('America/Rio_Branco','BR'),
  ('America/Rosario','AR'),
  ('America/Santa_Isabel','MX'),
  ('America/Santarem','BR'),
  ('America/Santiago','CL'),
  ('America/Santo_Domingo','DO'),
  ('America/Sao_Paulo','BR'),
  ('America/Scoresbysund','GL'),
  ('America/Shiprock','US'),
  ('America/Sitka','US'),
  ('America/St_Barthelemy','BL'),
  ('America/St_Johns','CA'),
  ('America/St_Kitts','KN'),
  ('America/St_Lucia','LC'),
  ('America/St_Thomas','VI'),
  ('America/St_Vincent','VC'),
  ('America/Swift_Current','CA'),
  ('America/Tegucigalpa','HN'),
  ('America/Thule','GL'),
  ('America/Thunder_Bay','CA'),
  ('America/Tijuana','MX'),
  ('America/Toronto','CA'),
  ('America/Tortola','VG'),
  ('America/Vancouver','CA'),
  ('America/Virgin','VI'),
  ('America/Whitehorse','CA'),
  ('America/Winnipeg','CA'),
  ('America/Yakutat','US'),
  ('America/Yellowknife','CA'),
  ('Antarctica/Casey','AQ'),
  ('Antarctica/Davis','AQ'),
  ('Antarctica/DumontDUrville','AQ'),
  ('Antarctica/Macquarie','AU'),
  ('Antarctica/Mawson','AQ'),
  ('Antarctica/McMurdo','AQ'),
  ('Antarctica/Palmer','AQ'),
  ('Antarctica/Rothera','AQ'),
  ('Antarctica/Syowa','AQ'),
  ('Antarctica/Troll','AQ'),
  ('Antarctica/Vostok','AQ'),
  ('Arctic/Longyearbyen','SJ'),
  ('Asia/Aden','YE'),
  ('Asia/Almaty','KZ'),
  ('Asia/Amman','JO'),
  ('Asia/Anadyr','RU'),
  ('Asia/Aqtau','KZ'),
  ('Asia/Aqtobe','KZ'),
  ('Asia/Ashgabat','TM'),
  ('Asia/Ashkhabad','TM'),
  ('Asia/Atyrau','KZ'),
  ('Asia/Baghdad','IQ'),
  ('Asia/Bahrain','BH'),
  ('Asia/Baku','AZ'),
  ('Asia/Bangkok','TH'),
  ('Asia/Barnaul','RU'),
  ('Asia/Beirut','LB'),
  ('Asia/Bishkek','KG'),
  ('Asia/Brunei','BN'),
  ('Asia/Calcutta','IN'),
  ('Asia/Chita','RU'),
  ('Asia/Choibalsan','MN'),
  ('Asia/Chongqing','CN'),
  ('Asia/Chungking','CN'),
  ('Asia/Colombo','LK'),
  ('Asia/Dacca','BD'),
  ('Asia/Damascus','SY'),
  ('Asia/Dhaka','BD'),
  ('Asia/Dili','TL'),
  ('Asia/Dubai','AE'),
  ('Asia/Dushanbe','TJ'),
  ('Asia/Famagusta','CY'),
  ('Asia/Gaza','PS'),
  ('Asia/Harbin','CN'),
  ('Asia/Hebron','PS'),
  ('Asia/Ho_Chi_Minh','VN'),
  ('Asia/Hong_Kong','HK'),
  ('Asia/Hovd','MN'),
  ('Asia/Irkutsk','RU'),
  ('Asia/Istanbul','TR'),
  ('Asia/Jakarta','ID'),
  ('Asia/Jayapura','ID'),
  ('Asia/Jerusalem','IL'),
  ('Asia/Kabul','AF'),
  ('Asia/Kamchatka','RU'),
  ('Asia/Karachi','PK'),
  ('Asia/Kashgar','CN'),
  ('Asia/Kathmandu','NP'),
  ('Asia/Katmandu','NP'),
  ('Asia/Khandyga','RU'),
  ('Asia/Kolkata','IN'),
  ('Asia/Krasnoyarsk','RU'),
  ('Asia/Kuala_Lumpur','MY'),
  ('Asia/Kuching','MY'),
  ('Asia/Kuwait','KW'),
  ('Asia/Macao','MO'),
  ('Asia/Macau','MO'),
  ('Asia/Magadan','RU'),
  ('Asia/Makassar','ID'),
  ('Asia/Manila','PH'),
  ('Asia/Muscat','OM'),
  ('Asia/Nicosia','CY'),
  ('Asia/Novokuznetsk','RU'),
  ('Asia/Novosibirsk','RU'),
  ('Asia/Omsk','RU'),
  ('Asia/Oral','KZ'),
  ('Asia/Phnom_Penh','KH'),
  ('Asia/Pontianak','ID'),
  ('Asia/Pyongyang','KP'),
  ('Asia/Qatar','QA'),
  ('Asia/Qostanay','KZ'),
  ('Asia/Qyzylorda','KZ'),
  ('Asia/Rangoon','MM'),
  ('Asia/Riyadh','SA'),
  ('Asia/Saigon','VN'),
  ('Asia/Sakhalin','RU'),
  ('Asia/Samarkand','UZ'),
  ('Asia/Seoul','KR'),
  ('Asia/Shanghai','CN'),
  ('Asia/Singapore','SG'),
  ('Asia/Srednekolymsk','RU'),
  ('Asia/Taipei','TW'),
  ('Asia/Tashkent','UZ'),
  ('Asia/Tbilisi','GE'),
  ('Asia/Tehran','IR'),
  ('Asia/Tel_Aviv','IL'),
  ('Asia/Thimbu','BT'),
  ('Asia/Thimphu','BT'),
  ('Asia/Tokyo','JP'),
  ('Asia/Tomsk','RU'),
  ('Asia/Ujung_Pandang','ID'),
  ('Asia/Ulaanbaatar','MN'),
  ('Asia/Urumqi','CN'),
  ('Asia/Ust-Nera','RU'),
  ('Asia/Vientiane','LA'),
  ('Asia/Vladivostok','RU'),
  ('Asia/Yakutsk','RU'),
  ('Asia/Yangon','MM'),
  ('Asia/Yekaterinburg','RU'),
  ('Asia/Yerevan','AM'),
  ('Atlantic/Azores','PT'),
  ('Atlantic/Bermuda','BM'),
  ('Atlantic/Canary','ES'),
  ('Atlantic/Cape_Verde','CV'),
  ('Atlantic/Faeroe','FO'),
  ('Atlantic/Faroe','FO'),
  ('Atlantic/Madeira','PT'),
  ('Atlantic/Reykjavik','IS'),
  ('Atlantic/South_Georgia','GS'),
  ('Atlantic/St_Helena','SH'),
  ('Atlantic/Stanley','FK'),
  ('Australia/ACT','AU'),
  ('Australia/Adelaide','AU'),
  ('Australia/Brisbane','AU'),
  ('Australia/Broken_Hill','AU'),
  ('Australia/Canberra','AU'),
  ('Australia/Currie','AU'),
  ('Australia/Darwin','AU'),
  ('Australia/Eucla','AU'),
  ('Australia/Hobart','AU'),
  ('Australia/LHI','AU'),
  ('Australia/Lindeman','AU'),
  ('Australia/Lord_Howe','AU'),
  ('Australia/Melbourne','AU'),
  ('Australia/NSW','AU'),
  ('Australia/North','AU'),
  ('Australia/Perth','AU'),
  ('Australia/Queensland','AU'),
  ('Australia/South','AU'),
  ('Australia/Sydney','AU'),
  ('Australia/Tasmania','AU'),
  ('Australia/Victoria','AU'),
  ('Australia/West','AU'),
  ('Australia/Yancowinna','AU'),
  ('Brazil/Acre','BR'),
  ('Brazil/DeNoronha','BR'),
  ('Brazil/East','BR'),
  ('Brazil/West','BR'),
  ('Canada/Atlantic','CA'),
  ('Canada/Central','CA'),
  ('Canada/Eastern','CA'),
  ('Canada/Mountain','CA'),
  ('Canada/Newfoundland','CA'),
  ('Canada/Pacific','CA'),
  ('Canada/Saskatchewan','CA'),
  ('Canada/Yukon','CA'),
  ('Chile/Continental','CL'),
  ('Chile/EasterIsland','CL'),
  ('Cuba','CU'),
  ('Egypt','EG'),
  ('Eire','IE'),
  ('Europe/Amsterdam','NL'),
  ('Europe/Andorra','AD'),
  ('Europe/Astrakhan','RU'),
  ('Europe/Athens','GR'),
  ('Europe/Belfast','GB'),
  ('Europe/Belgrade','RS'),
  ('Europe/Berlin','DE'),
  ('Europe/Bratislava','SK'),
  ('Europe/Brussels','BE'),
  ('Europe/Bucharest','RO'),
  ('Europe/Budapest','HU'),
  ('Europe/Busingen','DE'),
  ('Europe/Chisinau','MD'),
  ('Europe/Copenhagen','DK'),
  ('Europe/Dublin','IE'),
  ('Europe/Gibraltar','GI'),
  ('Europe/Guernsey','GG'),
  ('Europe/Helsinki','FI'),
  ('Europe/Isle_of_Man','IM'),
  ('Europe/Istanbul','TR'),
  ('Europe/Jersey','JE'),
  ('Europe/Kaliningrad','RU'),
  ('Europe/Kiev','UA'),
  ('Europe/Kirov','RU'),
  ('Europe/Kyiv','UA'),
  ('Europe/Lisbon','PT'),
  ('Europe/Ljubljana','SI'),
  ('Europe/London','GB'),
  ('Europe/Luxembourg','LU'),
  ('Europe/Madrid','ES'),
  ('Europe/Malta','MT'),
  ('Europe/Mariehamn','AX'),
  ('Europe/Minsk','BY'),
  ('Europe/Monaco','MC'),
  ('Europe/Moscow','RU'),
  ('Europe/Nicosia','CY'),
  ('Europe/Oslo','NO'),
  ('Europe/Paris','FR'),
  ('Europe/Podgorica','ME'),
  ('Europe/Prague','CZ'),
  ('Europe/Riga','LV'),
  ('Europe/Rome','IT'),
  ('Europe/Samara','RU'),
  ('Europe/San_Marino','SM'),
  ('Europe/Sarajevo','BA'),
  ('Europe/Saratov','RU'),
  ('Europe/Simferopol','UA'),
  ('Europe/Skopje','MK'),
  ('Europe/Sofia','BG'),
  ('Europe/Stockholm','SE'),
  ('Europe/Tallinn','EE'),
  ('Europe/Tirane','AL'),
  ('Europe/Tiraspol','MD'),
  ('Europe/Ulyanovsk','RU'),
  ('Europe/Uzhgorod','UA'),
  ('Europe/Vaduz','LI'),
  ('Europe/Vatican','VA'),
  ('Europe/Vienna','AT'),
  ('Europe/Vilnius','LT'),
  ('Europe/Volgograd','RU'),
  ('Europe/Warsaw','PL'),
  ('Europe/Zagreb','HR'),
  ('Europe/Zaporozhye','UA'),
  ('Europe/Zurich','CH'),
  ('GB','GB'),
  ('GB-Eire','GB'),
  ('Hongkong','HK'),
  ('Iceland','IS'),
  ('Indian/Antananarivo','MG'),
  ('Indian/Chagos','IO'),
  ('Indian/Christmas','CX'),
  ('Indian/Cocos','CC'),
  ('Indian/Comoro','KM'),
  ('Indian/Kerguelen','TF'),
  ('Indian/Mahe','SC'),
  ('Indian/Maldives','MV'),
  ('Indian/Mauritius','MU'),
  ('Indian/Mayotte','YT'),
  ('Indian/Reunion','RE'),
  ('Iran','IR'),
  ('Israel','IL'),
  ('Jamaica','JM'),
  ('Japan','JP'),
  ('Kwajalein','MH'),
  ('Libya','LY'),
  ('Mexico/BajaNorte','MX'),
  ('Mexico/BajaSur','MX'),
  ('Mexico/General','MX'),
  ('NZ','NZ'),
  ('NZ-CHAT','NZ'),
  ('Navajo','US'),
  ('PRC','CN'),
  ('Pacific/Apia','WS'),
  ('Pacific/Auckland','NZ'),
  ('Pacific/Bougainville','PG'),
  ('Pacific/Chatham','NZ'),
  ('Pacific/Chuuk','FM'),
  ('Pacific/Easter','CL'),
  ('Pacific/Efate','VU'),
  ('Pacific/Enderbury','KI'),
  ('Pacific/Fakaofo','TK'),
  ('Pacific/Fiji','FJ'),
  ('Pacific/Funafuti','TV'),
  ('Pacific/Galapagos','EC'),
  ('Pacific/Gambier','PF'),
  ('Pacific/Guadalcanal','SB'),
  ('Pacific/Guam','GU'),
  ('Pacific/Honolulu','US'),
  ('Pacific/Johnston','UM'),
  ('Pacific/Kanton','KI'),
  ('Pacific/Kiritimati','KI'),
  ('Pacific/Kosrae','FM'),
  ('Pacific/Kwajalein','MH'),
  ('Pacific/Majuro','MH'),
  ('Pacific/Marquesas','PF'),
  ('Pacific/Midway','UM'),
  ('Pacific/Nauru','NR'),
  ('Pacific/Niue','NU'),
  ('Pacific/Norfolk','NF'),
  ('Pacific/Noumea','NC'),
  ('Pacific/Pago_Pago','AS'),
  ('Pacific/Palau','PW'),
  ('Pacific/Pitcairn','PN'),
  ('Pacific/Pohnpei','FM'),
  ('Pacific/Ponape','FM'),
  ('Pacific/Port_Moresby','PG'),
  ('Pacific/Rarotonga','CK'),
  ('Pacific/Saipan','MP'),
  ('Pacific/Samoa','WS'),
  ('Pacific/Tahiti','PF'),
  ('Pacific/Tarawa','KI'),
  ('Pacific/Tongatapu','TO'),
  ('Pacific/Truk','FM'),
  ('Pacific/Wake','UM'),
  ('Pacific/Wallis','WF'),
  ('Pacific/Yap','FM'),
  ('Poland','PL'),
  ('Portugal','PT'),
  ('ROC','TW'),
  ('ROK','KR'),
  ('Singapore','SG'),
  ('Turkey','TR'),
  ('US/Alaska','US'),
  ('US/Aleutian','US'),
  ('US/Arizona','US'),
  ('US/Central','US'),
  ('US/East-Indiana','US'),
  ('US/Eastern','US'),
  ('US/Hawaii','US'),
  ('US/Indiana-Starke','US'),
  ('US/Michigan','US'),
  ('US/Mountain','US'),
  ('US/Pacific','US'),
  ('US/Samoa','WS'),
  ('W-SU','RU'),
  ('posixrules','US')
on conflict (zone) do update set country = excluded.country;

insert into public.iso_countries (code, name) values
  ('AD','Andorra'),
  ('AE','United Arab Emirates'),
  ('AF','Afghanistan'),
  ('AG','Antigua & Barbuda'),
  ('AI','Anguilla'),
  ('AL','Albania'),
  ('AM','Armenia'),
  ('AO','Angola'),
  ('AQ','Antarctica'),
  ('AR','Argentina'),
  ('AS','Samoa (American)'),
  ('AT','Austria'),
  ('AU','Australia'),
  ('AW','Aruba'),
  ('AX','Åland Islands'),
  ('AZ','Azerbaijan'),
  ('BA','Bosnia & Herzegovina'),
  ('BB','Barbados'),
  ('BD','Bangladesh'),
  ('BE','Belgium'),
  ('BF','Burkina Faso'),
  ('BG','Bulgaria'),
  ('BH','Bahrain'),
  ('BI','Burundi'),
  ('BJ','Benin'),
  ('BL','St Barthelemy'),
  ('BM','Bermuda'),
  ('BN','Brunei'),
  ('BO','Bolivia'),
  ('BQ','Caribbean NL'),
  ('BR','Brazil'),
  ('BS','Bahamas'),
  ('BT','Bhutan'),
  ('BV','Bouvet Island'),
  ('BW','Botswana'),
  ('BY','Belarus'),
  ('BZ','Belize'),
  ('CA','Canada'),
  ('CC','Cocos (Keeling) Islands'),
  ('CD','Congo (Dem. Rep.)'),
  ('CF','Central African Rep.'),
  ('CG','Congo (Rep.)'),
  ('CH','Switzerland'),
  ('CI','Côte d’Ivoire'),
  ('CK','Cook Islands'),
  ('CL','Chile'),
  ('CM','Cameroon'),
  ('CN','China'),
  ('CO','Colombia'),
  ('CR','Costa Rica'),
  ('CU','Cuba'),
  ('CV','Cape Verde'),
  ('CW','Curaçao'),
  ('CX','Christmas Island'),
  ('CY','Cyprus'),
  ('CZ','Czech Republic'),
  ('DE','Germany'),
  ('DJ','Djibouti'),
  ('DK','Denmark'),
  ('DM','Dominica'),
  ('DO','Dominican Republic'),
  ('DZ','Algeria'),
  ('EC','Ecuador'),
  ('EE','Estonia'),
  ('EG','Egypt'),
  ('EH','Western Sahara'),
  ('ER','Eritrea'),
  ('ES','Spain'),
  ('ET','Ethiopia'),
  ('FI','Finland'),
  ('FJ','Fiji'),
  ('FK','Falkland Islands'),
  ('FM','Micronesia'),
  ('FO','Faroe Islands'),
  ('FR','France'),
  ('GA','Gabon'),
  ('GB','Britain (UK)'),
  ('GD','Grenada'),
  ('GE','Georgia'),
  ('GF','French Guiana'),
  ('GG','Guernsey'),
  ('GH','Ghana'),
  ('GI','Gibraltar'),
  ('GL','Greenland'),
  ('GM','Gambia'),
  ('GN','Guinea'),
  ('GP','Guadeloupe'),
  ('GQ','Equatorial Guinea'),
  ('GR','Greece'),
  ('GS','South Georgia & the South Sandwich Islands'),
  ('GT','Guatemala'),
  ('GU','Guam'),
  ('GW','Guinea-Bissau'),
  ('GY','Guyana'),
  ('HK','Hong Kong'),
  ('HM','Heard Island & McDonald Islands'),
  ('HN','Honduras'),
  ('HR','Croatia'),
  ('HT','Haiti'),
  ('HU','Hungary'),
  ('ID','Indonesia'),
  ('IE','Ireland'),
  ('IL','Israel'),
  ('IM','Isle of Man'),
  ('IN','India'),
  ('IO','British Indian Ocean Territory'),
  ('IQ','Iraq'),
  ('IR','Iran'),
  ('IS','Iceland'),
  ('IT','Italy'),
  ('JE','Jersey'),
  ('JM','Jamaica'),
  ('JO','Jordan'),
  ('JP','Japan'),
  ('KE','Kenya'),
  ('KG','Kyrgyzstan'),
  ('KH','Cambodia'),
  ('KI','Kiribati'),
  ('KM','Comoros'),
  ('KN','St Kitts & Nevis'),
  ('KP','Korea (North)'),
  ('KR','Korea (South)'),
  ('KW','Kuwait'),
  ('KY','Cayman Islands'),
  ('KZ','Kazakhstan'),
  ('LA','Laos'),
  ('LB','Lebanon'),
  ('LC','St Lucia'),
  ('LI','Liechtenstein'),
  ('LK','Sri Lanka'),
  ('LR','Liberia'),
  ('LS','Lesotho'),
  ('LT','Lithuania'),
  ('LU','Luxembourg'),
  ('LV','Latvia'),
  ('LY','Libya'),
  ('MA','Morocco'),
  ('MC','Monaco'),
  ('MD','Moldova'),
  ('ME','Montenegro'),
  ('MF','St Martin (French)'),
  ('MG','Madagascar'),
  ('MH','Marshall Islands'),
  ('MK','North Macedonia'),
  ('ML','Mali'),
  ('MM','Myanmar (Burma)'),
  ('MN','Mongolia'),
  ('MO','Macau'),
  ('MP','Northern Mariana Islands'),
  ('MQ','Martinique'),
  ('MR','Mauritania'),
  ('MS','Montserrat'),
  ('MT','Malta'),
  ('MU','Mauritius'),
  ('MV','Maldives'),
  ('MW','Malawi'),
  ('MX','Mexico'),
  ('MY','Malaysia'),
  ('MZ','Mozambique'),
  ('NA','Namibia'),
  ('NC','New Caledonia'),
  ('NE','Niger'),
  ('NF','Norfolk Island'),
  ('NG','Nigeria'),
  ('NI','Nicaragua'),
  ('NL','Netherlands'),
  ('NO','Norway'),
  ('NP','Nepal'),
  ('NR','Nauru'),
  ('NU','Niue'),
  ('NZ','New Zealand'),
  ('OM','Oman'),
  ('PA','Panama'),
  ('PE','Peru'),
  ('PF','French Polynesia'),
  ('PG','Papua New Guinea'),
  ('PH','Philippines'),
  ('PK','Pakistan'),
  ('PL','Poland'),
  ('PM','St Pierre & Miquelon'),
  ('PN','Pitcairn'),
  ('PR','Puerto Rico'),
  ('PS','Palestine'),
  ('PT','Portugal'),
  ('PW','Palau'),
  ('PY','Paraguay'),
  ('QA','Qatar'),
  ('RE','Réunion'),
  ('RO','Romania'),
  ('RS','Serbia'),
  ('RU','Russia'),
  ('RW','Rwanda'),
  ('SA','Saudi Arabia'),
  ('SB','Solomon Islands'),
  ('SC','Seychelles'),
  ('SD','Sudan'),
  ('SE','Sweden'),
  ('SG','Singapore'),
  ('SH','St Helena'),
  ('SI','Slovenia'),
  ('SJ','Svalbard & Jan Mayen'),
  ('SK','Slovakia'),
  ('SL','Sierra Leone'),
  ('SM','San Marino'),
  ('SN','Senegal'),
  ('SO','Somalia'),
  ('SR','Suriname'),
  ('SS','South Sudan'),
  ('ST','Sao Tome & Principe'),
  ('SV','El Salvador'),
  ('SX','St Maarten (Dutch)'),
  ('SY','Syria'),
  ('SZ','Eswatini (Swaziland)'),
  ('TC','Turks & Caicos Is'),
  ('TD','Chad'),
  ('TF','French S. Terr.'),
  ('TG','Togo'),
  ('TH','Thailand'),
  ('TJ','Tajikistan'),
  ('TK','Tokelau'),
  ('TL','East Timor'),
  ('TM','Turkmenistan'),
  ('TN','Tunisia'),
  ('TO','Tonga'),
  ('TR','Turkey'),
  ('TT','Trinidad & Tobago'),
  ('TV','Tuvalu'),
  ('TW','Taiwan'),
  ('TZ','Tanzania'),
  ('UA','Ukraine'),
  ('UG','Uganda'),
  ('UM','US minor outlying islands'),
  ('US','United States'),
  ('UY','Uruguay'),
  ('UZ','Uzbekistan'),
  ('VA','Vatican City'),
  ('VC','St Vincent'),
  ('VE','Venezuela'),
  ('VG','Virgin Islands (UK)'),
  ('VI','Virgin Islands (US)'),
  ('VN','Vietnam'),
  ('VU','Vanuatu'),
  ('WF','Wallis & Futuna'),
  ('WS','Samoa (western)'),
  ('YE','Yemen'),
  ('YT','Mayotte'),
  ('ZA','South Africa'),
  ('ZM','Zambia'),
  ('ZW','Zimbabwe')
on conflict (code) do update set name = excluded.name;

-- The tz database's own country labels are terse and occasionally odd
-- ("Britain (UK)", "Korea (South)"). Override the ones a person would
-- read twice; everything else keeps the tzdata name.
insert into public.iso_countries (code, name) values
  ('GB','United Kingdom'), ('US','United States'), ('KR','South Korea'),
  ('KP','North Korea'), ('RU','Russia'), ('IR','Iran'), ('SY','Syria'),
  ('VE','Venezuela'), ('BO','Bolivia'), ('TZ','Tanzania'), ('MD','Moldova'),
  ('MK','North Macedonia'), ('LA','Laos'), ('BN','Brunei'), ('CZ','Czechia'),
  ('CD','DR Congo'), ('CG','Congo-Brazzaville'), ('FM','Micronesia'),
  ('PS','Palestine'), ('AE','United Arab Emirates'), ('VN','Vietnam'),
  ('TW','Taiwan'), ('HK','Hong Kong'), ('MO','Macau'), ('VA','Vatican City'),
  ('CI','Côte d''Ivoire'), ('CV','Cabo Verde'), ('SZ','Eswatini'),
  ('TL','Timor-Leste'), ('NL','Netherlands'), ('VG','British Virgin Islands'),
  ('VI','US Virgin Islands'), ('FK','Falkland Islands'), ('BQ','Caribbean Netherlands')
on conflict (code) do update set name = excluded.name;

-- Unknown or unmapped zones return null and are bucketed as "Unknown" by the
-- reporting function, never silently dropped — an empty map would otherwise
-- look like nobody visited rather than like a missing lookup.
create or replace function public.tz_country(tz text)
returns char(2)
language sql stable set search_path = public
as $$
  select t.country from public.tz_countries t where t.zone = tz;
$$;


-- ---------------------------------------------------------------------
-- 2. SMALL SHARED HELPERS
-- ---------------------------------------------------------------------

-- Cast that cannot throw. The plan blob is user-supplied text; one malformed
-- row must not take the whole dashboard down.
create or replace function public.try_jsonb(t text)
returns jsonb
language plpgsql immutable
as $$
begin
  return t::jsonb;
exception when others then
  return null;
end;
$$;

-- Just the named keys of an object, so two plans can be compared on the
-- fields that represent "somebody typed their own figures in" and nothing else.
create or replace function public.jsonb_pick(o jsonb, keys text[])
returns jsonb
language sql immutable
as $$
  select coalesce(
    (select jsonb_object_agg(k, o -> k) from unnest(keys) k where o ? k),
    '{}'::jsonb);
$$;

-- Every device an admin has ever been signed in on. Used by the "hide my own
-- activity" switch: with one real user, the developer's own browsing is most
-- of the data, and a dashboard that counts it is actively misleading.
create or replace function public.admin_own_devices()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(distinct e.device_id), '{}'::uuid[])
  from public.events e
  where e.user_id in (select a.user_id from public.admins a);
$$;


-- ---------------------------------------------------------------------
-- 3. WHAT "COMPLETE" MEANS — derived from the saved plan, not from an event
--
--    The old signal was the `plan_completed` event, which fires once per
--    device and only when both planners are touched in ONE page session.
--    Anybody who filled in their pension on Tuesday and their ISA on Thursday
--    never fired it. It also cannot say anything about a plan someone saved
--    before the event existed.
--
--    A pot now counts as filled in when the figures stored against the
--    account differ from the ones the app ships with. Because a new account
--    is seeded from whatever is in the browser at the time, someone who has
--    never typed anything stores the defaults verbatim — which is exactly
--    the case we want to read as "not filled in".
--
--    When the shipped defaults change, update the single row in
--    plan_defaults to match; nothing else needs touching.
-- ---------------------------------------------------------------------
create table if not exists public.plan_defaults (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null,
  note       text,
  updated_at timestamptz not null default now()
);
alter table public.plan_defaults enable row level security;

insert into public.plan_defaults (id, data, note) values (1, $json${
  "bridge": { "currentAge": 35, "currentBalance": 50000, "targetIncome": 43000,
              "phases": [{ "fromAge": 35, "toAge": 57, "annual": 10000 }] },
  "coast":  { "currentAge": 35, "currentPension": 90000, "targetIncome": 43000,
              "phases": [{ "fromAge": 35, "toAge": 60, "annual": 12000 }] }
}$json$::jsonb, 'Engine.BRIDGE_DEFAULTS / COAST_DEFAULTS as shipped 2026-08-22')
on conflict (id) do update
  set data = excluded.data, note = excluded.note, updated_at = now();

create or replace function public.plan_state(d jsonb)
returns jsonb
language sql stable set search_path = public
as $$
  with def as (select data from public.plan_defaults where id = 1),
  cur as (
    select public.try_jsonb(d ->> 'optionality.bridge') as b,
           public.try_jsonb(d ->> 'optionality.coast')  as c
  ),
  cmp as (
    select
      (cur.b is not null and public.jsonb_pick(cur.b, array['currentAge','currentBalance','targetIncome','phases'])
        is distinct from public.jsonb_pick(def.data -> 'bridge', array['currentAge','currentBalance','targetIncome','phases'])) as bridge,
      (cur.c is not null and public.jsonb_pick(cur.c, array['currentAge','currentPension','targetIncome','phases'])
        is distinct from public.jsonb_pick(def.data -> 'coast', array['currentAge','currentPension','targetIncome','phases'])) as coast,
      (cur.b is not null or cur.c is not null) as any_plan
    from cur, def
  )
  select jsonb_build_object(
    'has_plan', coalesce(any_plan, false),
    'bridge',   coalesce(bridge, false),
    'coast',    coalesce(coast, false),
    'complete', coalesce(bridge and coast, false)
  ) from cmp;
$$;


-- ---------------------------------------------------------------------
-- 4. IMPERSONATION — read-only, and logged
--
--    An admin may fetch one user's saved plan, in full, to reproduce what
--    they are seeing. There is deliberately no write path: this function
--    returns data and nothing else can be reached through it.
--
--    Every fetch writes a row here first. The insert happens BEFORE the read,
--    so a view cannot be performed without also being recorded.
-- ---------------------------------------------------------------------
create table if not exists public.admin_plan_views (
  id             bigserial primary key,
  viewed_at      timestamptz not null default now(),
  admin_id       uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  reason         text not null default ''
);
create index if not exists admin_plan_views_at_idx on public.admin_plan_views (viewed_at desc);
alter table public.admin_plan_views enable row level security;
-- No policy at all: reachable only through the definer functions below, so
-- neither a compromised admin session nor anyone else can rewrite the log.

create or replace function public.admin_view_plan(uid uuid, reason text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public, auth
as $$
declare blob jsonb; upd timestamptz; em text;
begin
  perform public.admin_guard();

  insert into public.admin_plan_views (admin_id, target_user_id, reason)
  values (auth.uid(), uid, left(coalesce(reason, ''), 500));

  select p.data, p.updated_at into blob, upd
    from public.projections p where p.user_id = uid;
  select u.email::text into em from auth.users u where u.id = uid;

  return jsonb_build_object(
    'user_id',    uid,
    'email',      em,
    'found',      blob is not null,
    'updated_at', upd,
    'state',      public.plan_state(coalesce(blob, '{}'::jsonb)),
    'data',       blob
  );
end;
$$;

create or replace function public.admin_audit(lim int default 50)
returns table (viewed_at timestamptz, admin_email text, target_email text, reason text)
language plpgsql stable security definer set search_path = public, auth
as $$
begin
  perform public.admin_guard();
  return query
  select v.viewed_at, au.email::text, tu.email::text, v.reason
  from public.admin_plan_views v
  left join auth.users au on au.id = v.admin_id
  left join auth.users tu on tu.id = v.target_user_id
  order by v.viewed_at desc
  limit greatest(1, least(lim, 500));
end;
$$;


-- ---------------------------------------------------------------------
-- 5. ONE USER, IN DETAIL — everything except the figures
--
--    The figures need admin_view_plan(), which logs. This does not, because
--    it carries nothing anyone could object to seeing: session counts,
--    device kinds, and which events fired when.
-- ---------------------------------------------------------------------
create or replace function public.admin_user_detail(uid uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, auth
as $$
declare r jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
    'user', (
      select jsonb_build_object(
        'user_id', u.id, 'email', u.email,
        'display_name', coalesce(u.raw_user_meta_data ->> 'full_name', ''),
        'created_at', u.created_at,
        'confirmed', (u.email_confirmed_at is not null))
      from auth.users u where u.id = uid),
    'activity', (
      select jsonb_build_object(
        'first_seen',  min(e.occurred_at),
        'last_active', max(e.occurred_at),
        'sessions',    count(distinct e.session_id),
        'events',      count(*),
        'devices',     count(distinct e.device_id))
      from public.events e where e.user_id = uid),
    -- devices this account has been used on, and what each of them did.
    -- Anonymous events from the same device are included: that is the whole
    -- point — people build a plan first and make an account afterwards.
    'devices', coalesce((
      select jsonb_agg(d order by d ->> 'last_seen' desc) from (
        select jsonb_build_object(
          'device_id', ud.did,
          'kind',      (select e.device_kind from public.events e
                         where e.device_id = ud.did order by e.occurred_at desc limit 1),
          'zone',      (select e.props ->> 'tz' from public.events e
                         where e.device_id = ud.did and e.props ? 'tz'
                         order by e.occurred_at desc limit 1),
          'first_seen',(select min(e.occurred_at) from public.events e where e.device_id = ud.did),
          'last_seen', (select max(e.occurred_at) from public.events e where e.device_id = ud.did),
          'sessions',  (select count(distinct e.session_id) from public.events e where e.device_id = ud.did),
          'completed', (select bool_or(e.name = 'plan_completed') from public.events e where e.device_id = ud.did),
          'installed', (select bool_or(e.name = 'app_launch') from public.events e where e.device_id = ud.did)
        ) d
        from (select distinct e.device_id as did from public.events e where e.user_id = uid) ud
      ) x), '[]'::jsonb),
    'event_counts', coalesce((
      select jsonb_object_agg(t.name, t.n) from (
        select e.name, count(*) n from public.events e where e.user_id = uid group by e.name) t
      ), '{}'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', e.occurred_at, 'name', e.name, 'kind', e.device_kind, 'props', e.props)
               order by e.occurred_at desc)
      from (select * from public.events e2 where e2.user_id = uid
            order by e2.occurred_at desc limit 40) e
      ), '[]'::jsonb),
    'plan', (
      select jsonb_build_object(
        'updated_at', p.updated_at,
        'bytes',      pg_column_size(p.data),
        'state',      public.plan_state(p.data))
      from public.projections p where p.user_id = uid),
    -- corroboration, not the source of truth any more
    'plan_completed_event', coalesce((
      select bool_or(e.name = 'plan_completed') from public.events e
      where e.device_id in (select distinct e2.device_id from public.events e2 where e2.user_id = uid)),
      false),
    'views', coalesce((
      select count(*) from public.admin_plan_views v where v.target_user_id = uid), 0)
  ) into r;

  return r;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. WHERE PEOPLE ARE
--
--    Source: the browser's own IANA timezone, sent as a prop on `visit`.
--    No IP address is looked at and no geolocation service is called, so
--    nothing about a visitor leaves our own database. It is a good enough
--    signal for "which countries is this reaching", and a bad one for
--    anything finer — a VPN or somebody on holiday reads as that country.
--
--    Devices whose zone we have never seen are reported as "Unknown" rather
--    than dropped, and an unmapped zone is reported separately so the lookup
--    table can be widened instead of quietly under-counting.
-- ---------------------------------------------------------------------
create or replace function public.admin_countries(p text default '30d', kind text default 'all', excl boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; since timestamptz; dev uuid[];
begin
  perform public.admin_guard();
  since := public.period_start(p);
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  with scoped as (
    select * from public.events e
    where e.occurred_at >= since
      and (kind = 'all' or e.device_kind = kind)
      and not (e.device_id = any(dev))
  ),
  -- one zone per device: the most recent one it reported
  dz as (
    select distinct on (s.device_id)
           s.device_id, s.props ->> 'tz' as zone
    from scoped s
    where s.props ? 'tz'
    order by s.device_id, s.occurred_at desc
  ),
  all_dev as (
    select distinct s.device_id from scoped s
  ),
  joined as (
    select ad.device_id, dz.zone, public.tz_country(dz.zone) as cc
    from all_dev ad left join dz on dz.device_id = ad.device_id
  ),
  rolled as (
    select coalesce(cc, '??') as code, count(*) as devices
    from joined group by 1
  ),
  total as (select sum(devices) t from rolled)
  select jsonb_build_object(
    'total_devices', (select t from total),
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code',    rolled.code,
               'name',    case when rolled.code = '??' then 'Unknown'
                               else coalesce(ic.name, rolled.code) end,
               'devices', rolled.devices,
               'pct',     case when (select t from total) > 0
                               then round(100.0 * rolled.devices / (select t from total), 1) end)
             order by rolled.devices desc, rolled.code)
      from rolled left join public.iso_countries ic on ic.code = rolled.code
      ), '[]'::jsonb),
    -- zones we received but have no country for: fix by inserting into tz_countries
    'unmapped', coalesce((
      select jsonb_agg(distinct j.zone) from joined j
      where j.zone is not null and j.cc is null), '[]'::jsonb),
    'no_zone', (select count(*) from joined j where j.zone is null),
    -- phone / tablet / desktop by DEVICE (its most recent kind), not by event,
    -- so a chatty desktop session can't outweigh ten quiet phones
    'device_mix', coalesce((
      select jsonb_object_agg(k.kind, k.n) from (
        select dk.kind, count(*) n from (
          select distinct on (s.device_id) s.device_id, s.device_kind as kind
          from scoped s order by s.device_id, s.occurred_at desc
        ) dk group by dk.kind
      ) k), '{}'::jsonb)
  ) into r;

  return r;
end;
$$;


-- ---------------------------------------------------------------------
-- 7. THE EXISTING REPORTS, with the "hide my own activity" switch
--    (bodies otherwise unchanged from analytics.sql / 002)
-- ---------------------------------------------------------------------
create or replace function public.admin_overview(excl boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public, auth
as $$
declare r jsonb; dev uuid[];
begin
  perform public.admin_guard();
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  with ev as (
    select * from public.events e where not (e.device_id = any(dev))
  )
  select jsonb_build_object(
    'users', jsonb_build_object(
      'total',       (select count(*) from auth.users),
      'new_7d',      (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'new_30d',     (select count(*) from auth.users where created_at > now() - interval '30 days'),
      'active_24h',  (select count(distinct user_id) from ev
                       where user_id is not null and occurred_at > now() - interval '24 hours'),
      'active_7d',   (select count(distinct user_id) from ev
                       where user_id is not null and occurred_at > now() - interval '7 days'),
      'active_30d',  (select count(distinct user_id) from ev
                       where user_id is not null and occurred_at > now() - interval '30 days'),
      'unconfirmed', (select count(*) from auth.users where email_confirmed_at is null),
      -- how many accounts hold figures somebody actually typed
      'with_plan',   (select count(*) from public.projections p
                       where (public.plan_state(p.data) ->> 'complete')::boolean)
    ),
    'engagement', jsonb_build_object(
      'plans_created',   (select count(distinct device_id) from ev where name = 'finances_entered'),
      'plans_completed', (select count(distinct device_id) from ev where name = 'plan_completed'),
      'returning_users', (select count(*) from (
                            select user_id from ev
                            where user_id is not null
                            group by user_id having count(distinct session_id) > 1) t),
      'avg_sessions_per_user', (select round(avg(s), 1) from (
                            select count(distinct session_id) s from ev
                            where user_id is not null group by user_id) t),
      'visitors_30d',    (select count(distinct device_id) from ev
                            where occurred_at > now() - interval '30 days'),
      'sessions_30d',    (select count(distinct session_id) from ev
                            where occurred_at > now() - interval '30 days')
    ),
    -- so a dashboard that has quietly stopped receiving anything says so
    'meta', jsonb_build_object(
      'last_event_at', (select max(occurred_at) from ev),
      'events_total',  (select count(*) from ev),
      'devices_total', (select count(distinct device_id) from ev),
      'excluded_devices', coalesce(array_length(dev, 1), 0)
    )
  ) into r;
  return r;
end;
$$;


create or replace function public.admin_funnel(p text default '30d', kind text default 'all', excl boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; since timestamptz; dev uuid[];
begin
  perform public.admin_guard();
  since := public.period_start(p);
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  with scoped as (
    select * from public.events
    where occurred_at >= since
      and (kind = 'all' or device_kind = kind)
      and not (device_id = any(dev))
  ), d as (
    select device_id,
           bool_or(name = 'visit')            as visited,
           bool_or(name = 'finances_entered') as entered,
           bool_or(name = 'plan_completed')   as completed,
           bool_or(name = 'register')         as registered,
           bool_or(name = 'return_visit')     as returned
    from scoped group by device_id
  ), c as (
    select
      count(*) filter (where visited)                                                  as s1,
      count(*) filter (where visited and entered)                                      as s2,
      count(*) filter (where visited and entered and completed)                        as s3,
      count(*) filter (where visited and entered and completed and registered)         as s4,
      count(*) filter (where visited and entered and completed and registered
                             and returned)                                             as s5
    from d
  )
  select jsonb_build_array(
    jsonb_build_object('stage','Visited',          'count', s1,
                       'pct_of_prev', null,
                       'pct_of_top',  case when s1 > 0 then 100.0 end),
    jsonb_build_object('stage','Entered finances', 'count', s2,
                       'pct_of_prev', case when s1 > 0 then round(100.0*s2/s1,1) end,
                       'pct_of_top',  case when s1 > 0 then round(100.0*s2/s1,1) end),
    jsonb_build_object('stage','Completed plan',   'count', s3,
                       'pct_of_prev', case when s2 > 0 then round(100.0*s3/s2,1) end,
                       'pct_of_top',  case when s1 > 0 then round(100.0*s3/s1,1) end),
    jsonb_build_object('stage','Registered',       'count', s4,
                       'pct_of_prev', case when s3 > 0 then round(100.0*s4/s3,1) end,
                       'pct_of_top',  case when s1 > 0 then round(100.0*s4/s1,1) end),
    jsonb_build_object('stage','Returned',         'count', s5,
                       'pct_of_prev', case when s4 > 0 then round(100.0*s5/s4,1) end,
                       'pct_of_top',  case when s1 > 0 then round(100.0*s5/s1,1) end)
  ) into r from c;

  return r;
end;
$$;


create or replace function public.admin_features(p text default '30d', kind text default 'all', excl boolean default false)
returns table (feature text, label text, devices bigint, users bigint, pct_of_active numeric)
language plpgsql stable security definer set search_path = public
as $$
declare since timestamptz; base bigint; dev uuid[];
begin
  perform public.admin_guard();
  since := public.period_start(p);
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  select count(distinct e.device_id) into base from public.events e
   where e.occurred_at >= since and e.name = 'finances_entered'
     and (kind = 'all' or e.device_kind = kind)
     and not (e.device_id = any(dev));

  return query
  with names(n, l) as (values
    ('edit_savings',          'Changed savings assumptions'),
    ('edit_target_income',    'Changed target income'),
    ('edit_target_age',       'Changed target optionality age'),
    ('open_advanced',         'Opened advanced assumptions'),
    ('edit_return_inflation', 'Changed return / inflation'),
    ('per_pot_assumptions',   'Different assumptions by pot'),
    ('view_projection',       'Viewed detailed projections'),
    ('scenario_toggle',       'Toggled a scenario'),
    ('sooner_levers',         'Used "get me there sooner"'),
    ('units_toggle',          'Switched today''s money / nominal'),
    ('export_csv',            'Exported CSV'),
    ('plan_updated',          'Returned and updated a plan'),
    ('install_click',         'Tapped Install app'),
    ('app_launch',            'Opened it as an installed app')
  )
  select names.n,
         names.l,
         coalesce(e.devices, 0),
         coalesce(e.users, 0),
         case when base > 0 then round(100.0 * coalesce(e.devices,0) / base, 1) else null end
  from names
  left join (
    select ev.name,
           count(distinct ev.device_id) devices,
           count(distinct ev.user_id)   users
    from public.events ev
    where ev.occurred_at >= since and (kind = 'all' or ev.device_kind = kind)
      and not (ev.device_id = any(dev))
    group by ev.name
  ) e on e.name = names.n
  order by coalesce(e.devices, 0) desc;
end;
$$;


create or replace function public.admin_installs(p text default 'all', kind text default 'all', excl boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; since timestamptz; dev uuid[];
begin
  perform public.admin_guard();
  since := public.period_start(p);
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  with scoped as (
    select * from public.events
    where occurred_at >= since and (kind = 'all' or device_kind = kind)
      and not (device_id = any(dev))
  )
  select jsonb_build_object(
    'clicked',        (select count(distinct device_id) from scoped where name = 'install_click'),
    'prompted',       (select count(distinct device_id) from scoped where name = 'install_prompted'),
    'accepted',       (select count(distinct device_id) from scoped where name = 'install_accepted'),
    'dismissed',      (select count(distinct device_id) from scoped where name = 'install_dismissed'),
    'help_shown',     (select count(distinct device_id) from scoped where name = 'install_help'),
    'installed',      (select count(distinct device_id) from scoped where name = 'app_installed'),
    'launch_devices', (select count(distinct device_id) from scoped where name = 'app_launch'),
    'launches',       (select count(*)                  from scoped where name = 'app_launch'),
    'help_by_platform', coalesce((
      select jsonb_object_agg(pf, n) from (
        select coalesce(props ->> 'platform', 'unknown') pf, count(distinct device_id) n
        from scoped where name = 'install_help' group by 1
      ) t), '{}'::jsonb),
    'visitors',       (select count(distinct device_id) from scoped)
  ) into r;

  return r;
end;
$$;


-- Sessions added as a fourth series — visitors alone can't tell "more people"
-- from "the same people coming back more often".
create or replace function public.admin_trend(p text default '30d', excl boolean default false)
returns table (day date, visitors bigint, sessions bigint, new_users bigint, completions bigint)
language plpgsql stable security definer set search_path = public, auth
as $$
declare since timestamptz; dev uuid[];
begin
  perform public.admin_guard();
  since := greatest(public.period_start(p), now() - interval '180 days');
  dev := case when excl then public.admin_own_devices() else '{}'::uuid[] end;

  return query
  with days as (
    select generate_series(since::date, now()::date, interval '1 day')::date d
  ), ev as (
    select * from public.events e where not (e.device_id = any(dev))
  )
  select days.d,
         (select count(distinct e.device_id)  from ev e where e.occurred_at::date = days.d),
         (select count(distinct e.session_id) from ev e where e.occurred_at::date = days.d),
         (select count(*) from auth.users u where u.created_at::date = days.d),
         (select count(distinct e.device_id)  from ev e
           where e.occurred_at::date = days.d and e.name = 'plan_completed')
  from days order by days.d;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. USER LIST
--
--    Still carries no financial figures — only WHICH pots have been filled
--    in, never with what. The figures need admin_view_plan(), which logs.
--
--    filter: all | new | active | recent | inactive | never | complete |
--            incomplete | no_plan | unconfirmed
--    sort:   email | created | last_active | sessions | updated
-- ---------------------------------------------------------------------
create or replace function public.admin_users(
  search text default '',
  filter text default 'all',
  sort   text default 'last_active',
  dir    text default 'desc',
  lim    int  default 50,
  off    int  default 0
)
returns table (
  user_id       uuid,
  email         text,
  display_name  text,
  created_at    timestamptz,
  confirmed     boolean,
  last_active   timestamptz,
  sessions      bigint,
  devices       bigint,
  bridge_filled boolean,
  coast_filled  boolean,
  plan_complete boolean,
  plan_event    boolean,
  has_plan      boolean,
  plan_updated  timestamptz,
  device_kinds  text,
  country       text,
  status        text,
  total_count   bigint
)
language plpgsql stable security definer set search_path = public, auth
as $$
begin
  perform public.admin_guard();

  return query
  -- ⚠️ CTE columns must NOT be called user_id or device_id: this function has
  -- OUT parameters with those names and an unqualified reference is ambiguous.
  with agg as (
    select e.user_id as uid,
           max(e.occurred_at)           as last_active,
           count(distinct e.session_id) as sessions,
           count(distinct e.device_id)  as devices,
           string_agg(distinct e.device_kind, ', ' order by e.device_kind) as device_kinds
    from public.events e where e.user_id is not null group by e.user_id
  ), user_devices as (
    select distinct e.user_id as uid, e.device_id as did
    from public.events e where e.user_id is not null
  ), completed_devices as (
    select distinct e.device_id as did from public.events e where e.name = 'plan_completed'
  ), device_credit as (
    select ud.uid from user_devices ud join completed_devices cd on cd.did = ud.did group by ud.uid
  ), user_zone as (
    -- most recent timezone reported by any device this account has been used on
    select distinct on (ud.uid) ud.uid, e.props ->> 'tz' as zone
    from user_devices ud
    join public.events e on e.device_id = ud.did and e.props ? 'tz'
    order by ud.uid, e.occurred_at desc
  ), rows as (
    select u.id,
           u.email::text                                       as email,
           coalesce(u.raw_user_meta_data ->> 'full_name', '')   as display_name,
           u.created_at,
           (u.email_confirmed_at is not null)                   as confirmed,
           a.last_active,
           coalesce(a.sessions, 0)                              as sessions,
           coalesce(a.devices, 0)                               as devices,
           coalesce((public.plan_state(pr.data) ->> 'bridge')::boolean, false)   as bridge_filled,
           coalesce((public.plan_state(pr.data) ->> 'coast')::boolean, false)    as coast_filled,
           coalesce((public.plan_state(pr.data) ->> 'complete')::boolean, false) as plan_complete,
           exists (select 1 from device_credit dc where dc.uid = u.id)           as plan_event,
           (pr.user_id is not null)                             as has_plan,
           pr.updated_at                                        as plan_updated,
           coalesce(a.device_kinds, '')                         as device_kinds,
           coalesce(
             (select ic.name from user_zone uz
               left join public.iso_countries ic on ic.code = public.tz_country(uz.zone)
              where uz.uid = u.id), '')                         as country,
           case
             when u.email_confirmed_at is null                        then 'unconfirmed'
             when a.last_active is null                               then 'never used'
             when a.last_active > now() - interval '7 days'           then 'active'
             when a.last_active > now() - interval '30 days'          then 'idle'
             else 'dormant'
           end                                                  as status
    from auth.users u
    left join agg a                 on a.uid = u.id
    left join public.projections pr on pr.user_id = u.id
  ), filtered as (
    select * from rows r
    where (search = '' or r.email ilike '%'||search||'%' or r.display_name ilike '%'||search||'%')
      and case filter
            when 'new'         then r.created_at > now() - interval '7 days'
            when 'active'      then r.last_active > now() - interval '7 days'
            when 'recent'      then r.last_active > now() - interval '24 hours'
            when 'inactive'    then (r.last_active is null or r.last_active < now() - interval '30 days')
            when 'never'       then r.last_active is null
            when 'complete'    then r.plan_complete
            when 'incomplete'  then (r.has_plan and not r.plan_complete)
            when 'no_plan'     then not r.has_plan
            when 'unconfirmed' then r.confirmed = false
            else true
          end
  )
  select f.id, f.email, f.display_name, f.created_at, f.confirmed, f.last_active,
         f.sessions, f.devices, f.bridge_filled, f.coast_filled, f.plan_complete,
         f.plan_event, f.has_plan, f.plan_updated, f.device_kinds, f.country, f.status,
         (select count(*) from filtered)
  from filtered f
  order by
    case when dir = 'asc' then
      case sort when 'created'  then extract(epoch from f.created_at)
                when 'sessions' then f.sessions::numeric
                when 'updated'  then extract(epoch from f.plan_updated)
                else extract(epoch from f.last_active) end
    end asc nulls last,
    case when dir <> 'asc' then
      case sort when 'created'  then extract(epoch from f.created_at)
                when 'sessions' then f.sessions::numeric
                when 'updated'  then extract(epoch from f.plan_updated)
                else extract(epoch from f.last_active) end
    end desc nulls last,
    case when sort = 'email' and dir = 'asc'  then f.email end asc  nulls last,
    case when sort = 'email' and dir <> 'asc' then f.email end desc nulls last
  limit greatest(1, least(lim, 200)) offset greatest(0, off);
end;
$$;


-- ---------------------------------------------------------------------
-- 9. GRANTS — signed-in users may call these; each one checks is_admin().
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'admin_overview(boolean)',
    'admin_model_medians()',
    'admin_median_optionality_age()',
    'admin_funnel(text,text,boolean)',
    'admin_features(text,text,boolean)',
    'admin_trend(text,boolean)',
    'admin_installs(text,text,boolean)',
    'admin_countries(text,text,boolean)',
    'admin_users(text,text,text,text,int,int)',
    'admin_user_detail(uuid)',
    'admin_view_plan(uuid,text)',
    'admin_audit(int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- helpers stay off the API surface entirely
revoke all on function public.tz_country(text)        from public, anon, authenticated;
revoke all on function public.plan_state(jsonb)       from public, anon, authenticated;
revoke all on function public.admin_own_devices()     from public, anon, authenticated;
revoke all on function public.jsonb_pick(jsonb,text[]) from public, anon, authenticated;
revoke all on function public.try_jsonb(text)         from public, anon, authenticated;

-- PostgREST caches the function list; nudge it so the new signatures are live.
notify pgrst, 'reload schema';
