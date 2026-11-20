# Sample photos for Share unseen

Real photos, used by the unit tests (`test/unit/v2/photo.test.ts`) and the phone-sized browser test (`test/ui/photo.ui.test.ts`).

| File | What it is | Source | Licence |
|---|---|---|---|
| `sign.jpg` | A road sign ("138A") at dawn, taken on a Samsung SM-S906U1 phone. Unchanged from the source, so it keeps the phone's own Exif: GPS position, make and model, firmware, the time it was taken and an embedded thumbnail. | [Wikimedia Commons, "Route 138A navigation sign at dawn.jpg"](https://commons.wikimedia.org/wiki/File:Route_138A_navigation_sign_at_dawn.jpg), by ZeLonewolf. SHA-1 `d28b7e1017ed5242a037c6a2a0c33c12eed1531d`. | CC0 1.0 |
| `crew.jpg` | The Apollo 11 crew portrait (NASA, 1969): three faces looking at the camera, and name tags on the suits. Scaled from 4200 px to 960 px wide; its Exif (Photoshop software, dates, thumbnail) and colour profile were kept. | [Wikimedia Commons, "Apollo 11 Crew.jpg"](https://commons.wikimedia.org/wiki/File:Apollo_11_Crew.jpg), NASA. Original SHA-1 `869cb2c816bdcfc960ef7cb89c2e4b2c6c5d827c`. | Public domain (work of the US government) |

## Crowd photos (`crowd/`)

Ten protest and crowd photos with small faces, for the face filter: the UI test checks that every face in `protest-wide.jpg` is covered, the unit tests check the writing finder on two of them, and [`scripts/face-score.ts`](../../../../scripts/face-score.ts) scores a face filter on all ten (see [docs/modules/filter.md](../../../../docs/modules/filter.md#scoring-it)). Each was scaled down from the original on Wikimedia Commons with Pillow (Lanczos, then JPEG quality 72, 80 for `protest-wide.jpg`), with no Exif kept. `protest-wide.jpg` is the 1,280 pixel version of the photo on which the earlier face finder found no faces.

`faces.json` marks by hand every face at least 12 pixels tall that a person could tell: 304 in all. Candidates came from two detectors run at several sizes (YuNet and face-api's tiny face detector), each looked at enlarged and kept or dropped by eye; the photos were then looked over with the kept boxes drawn, for faces neither had found. A face both detectors missed in that pass could still be unmarked. The `ignore` boxes are places a cover is neither right nor wrong: faces too blurred, hidden or turned to call either way, and helmets with visors.

| File | Original | Source | Author | Licence |
|---|---|---|---|---|
| `protest-wide.jpg` | 2000 x 1333, SHA-1 `59bcfc607af11771d4ea1151577a0fec96d88400` | [Protesta por el Día del Estudiante en Caracas, 2018 06.jpg](https://commons.wikimedia.org/wiki/File:Protesta_por_el_D%C3%ADa_del_Estudiante_en_Caracas,_2018_06.jpg) | PROVEA | Public domain (PD-author, Flickr Public Domain Mark) |
| `march.jpg` | 2000 x 1500, SHA-1 `c3bc6ff80e983b6ada8c175a3ed953861fccc1b1` | [Protesta por el Día del Estudiante en Caracas, 2018 44.jpg](https://commons.wikimedia.org/wiki/File:Protesta_por_el_D%C3%ADa_del_Estudiante_en_Caracas,_2018_44.jpg) | PROVEA | Public domain (PD-author, Flickr Public Domain Mark) |
| `banner.jpg` | 2000 x 1500, SHA-1 `83958039aa91d364e9572d55f121709a449eb9df` | [Protesta por el Día del Estudiante en Caracas, 2018 41.jpg](https://commons.wikimedia.org/wiki/File:Protesta_por_el_D%C3%ADa_del_Estudiante_en_Caracas,_2018_41.jpg) | PROVEA | Public domain (PD-author, Flickr Public Domain Mark) |
| `nurses.jpg` | 2000 x 1333, SHA-1 `9d0961661c3763aa5079012201f829d6043f7a85` | [Protesta de trabajadores de la salud en Venezuela, 2018 01.jpg](https://commons.wikimedia.org/wiki/File:Protesta_de_trabajadores_de_la_salud_en_Venezuela,_2018_01.jpg) | PROVEA | Public domain (PD-author, Flickr Public Domain Mark) |
| `signs.jpg` | 2000 x 1333, SHA-1 `8b7d0ec85f99404fd7e2cb445d1f73ca17bd7371` | [Protesta de trabajadores de la salud en Venezuela, 2018 16.jpg](https://commons.wikimedia.org/wiki/File:Protesta_de_trabajadores_de_la_salud_en_Venezuela,_2018_16.jpg) | PROVEA | Public domain (PD-author, Flickr Public Domain Mark) |
| `helmets.jpg` | 2000 x 1333, SHA-1 `286d824c1f0c4d1dca97b83ec072eee504baaceb` | [Protesta tobosVACIOS en Caracas 23.jpg](https://commons.wikimedia.org/wiki/File:Protesta_tobosVACIOS_en_Caracas_23.jpg) | PROVEA | Public domain (PD-author, Flickr Public Domain Mark) |
| `placards.jpg` | 5184 x 3456, SHA-1 `972b4daf84e280b95c363b8048a4d84a7917b45a` | [Protesta por salarios en Venezuela, 2018 08.jpg](https://commons.wikimedia.org/wiki/File:Protesta_por_salarios_en_Venezuela,_2018_08.jpg) | PROVEA | Public domain (PD-author, Flickr Public Domain Mark) |
| `group.jpg` | 7654 x 4964, SHA-1 `c69937f36eb32cf2534317ef92d99d3cd494d8ab` | [Demonstration of Venezuelans in Quebec against the dictatorship in Venezuela.jpg](https://commons.wikimedia.org/wiki/File:Demonstration_of_Venezuelans_in_Quebec_against_the_dictatorship_in_Venezuela.jpg) | Wilfredor | CC0 1.0 |
| `arrest.jpg` | 4608 x 2490, SHA-1 `3e50916f4a15b89e6bbeed7805199ec571adfdca` | [February 2016 DRC protests Buvaku.jpg](https://commons.wikimedia.org/wiki/File:February_2016_DRC_protests_Buvaku.jpg) | Ernest Muhero, Voice of America | Public domain (work of the US government, VOA) |
| `dust.jpg` | 5760 x 3840, SHA-1 `8e9d90940d5330d59f58fa4a9fae1cd5706524cb` | [Myanmar National Education Law Protests 2.jpg](https://commons.wikimedia.org/wiki/File:Myanmar_National_Education_Law_Protests_2.jpg) | Sithu Naina, Voice of America | Public domain (work of the US government, VOA) |

`protest-wide.jpg` is 1280 x 853; the others are 1440 pixels wide. Together the ten are about 2.3 MB.
