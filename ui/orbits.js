// Heliocentric positions from JPL's "approximate positions of the planets"
// element set (J2000 epoch plus linear rates, valid roughly 1800-2050).
// a AU, e, L mean longitude deg, wbar longitude of perihelion deg, and the
// per-century rates. Positions from these are good to a fraction of a degree,
// which is far better than the map can draw.
window.ORBITS={
 MERCURY:{a:0.38709927,e:0.20563593,L:252.25032350,w:77.45779628,dL:149472.67411175},
 VENUS:  {a:0.72333566,e:0.00677672,L:181.97909950,w:131.60246718,dL:58517.81538729},
 EARTH:  {a:1.00000261,e:0.01671123,L:100.46457166,w:102.93768193,dL:35999.37244981},
 MARS:   {a:1.52371034,e:0.09339410,L:-4.55343205, w:-23.94362959,dL:19140.30268499},
 JUPITER:{a:5.20288700,e:0.04838624,L:34.39644051, w:14.72847983, dL:3034.74612775},
 SATURN: {a:9.53667594,e:0.05386179,L:49.95424423, w:92.59887831, dL:1222.49362201},
 URANUS: {a:19.18916464,e:0.04725744,L:313.23810451,w:170.95427630,dL:428.48202785},
 NEPTUNE:{a:30.06992276,e:0.00859048,L:-55.12002969,w:44.96476227,dL:218.45945325}
};
// Everything below is APPROXIMATE: mean elements only, no proper epoch fit.
// Angles will drift from reality; they are here so the belt and the comets
// move plausibly rather than sitting still.
window.ORBITS_APPROX={
 PLUTO:{a:39.48,e:0.2488,L:238.93,w:224.07,per:247.9},
 CERES:{a:2.7675,e:0.0757,L:95.99,w:73.6,per:4.60},
 VESTA:{a:2.3617,e:0.0889,L:307.8,w:151.2,per:3.63},
 PALLAS:{a:2.7720,e:0.2299,L:60.9,w:310.9,per:4.62},
 PSYCHE16:{a:2.9230,e:0.1339,L:150.2,w:229.5,per:4.99},
 BENNU:{a:1.1264,e:0.2037,L:101.7,w:66.2,per:1.20},
 RYUGU:{a:1.1896,e:0.1902,L:23.6,w:211.4,per:1.30},
 EROS:{a:1.4581,e:0.2227,L:311.5,w:178.9,per:1.76},
 APOPHIS:{a:0.9224,e:0.1914,L:200.0,w:126.4,per:0.89},
 HALLEY:{a:17.834,e:0.9679,L:274.0,w:112.0,per:75.3},
 ENCKE:{a:2.2155,e:0.8483,L:150.0,w:186.5,per:3.30},
 CG67P:{a:3.4630,e:0.6410,L:310.0,w:22.3,per:6.44},
 HALEBOPP:{a:186.0,e:0.9951,L:5.0,w:130.6,per:2533}
};
// Kepler: mean anomaly -> eccentric -> true, then heliocentric ecliptic x,y.
window.solveOrbit=function(el, jd){
  const T=(jd-2451545.0)/36525.0;                   // centuries since J2000
  let L, a=el.a, e=el.e, w=el.w;
  if(el.dL!=null) L = el.L + el.dL*T;
  else            L = el.L + (360/el.per)*(jd-2451545.0)/365.25;
  let M = ((L - w) % 360 + 360) % 360;
  const Mr = M*Math.PI/180;
  let E = Mr;
  for(let k=0;k<8;k++) E = E - (E - e*Math.sin(E) - Mr)/(1 - e*Math.cos(E));
  const nu = 2*Math.atan2(Math.sqrt(1+e)*Math.sin(E/2), Math.sqrt(1-e)*Math.cos(E/2));
  const r  = a*(1 - e*Math.cos(E));
  const lam = nu + w*Math.PI/180;                   // heliocentric ecliptic longitude
  return {r, lam, x:r*Math.cos(lam), y:r*Math.sin(lam)};
};
window.toJD=function(ms){ return ms/86400000 + 2440587.5; };
