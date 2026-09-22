"""m-RAPA JSON + Leaflet QA HTML 생성."""
import datetime, json, math

def build_json(rapa_key, cplx_name, cplx_poly_w, buildings, transform, source_desc):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return {
        'rapaKey': rapa_key,
        'queriedAt': now,
        'complex': {'bld_cplx_inf_id': None, 'cplx_scl_nm': cplx_name, 'polygon': cplx_poly_w},
        'buildingSource': source_desc,
        'bufferDeg': None,
        'buildings': buildings,
        'skipped': False, 'skipReason': None,
        'stats': {'total': len(buildings), 'inComplex': len(buildings), 'neighbors': 0,
                  'duct_buildings': sum(1 for b in buildings if b.get('is_duct_building')),
                  'rooftop_antennas': sum(b.get('rooftop_repeater_count', 0) for b in buildings)},
        'georeference': None if not transform else {
            'method': transform.get('method', 'cadastral GCP similarity fit + north-arrow verify'),
            'scale_mm_to_m': transform['S'], 'rotation_deg_ccw': transform['theta_deg'],
            'gcp_rms_m': round(transform['rms_m'], 2) if transform.get('rms_m') is not None else None,
            'gcp_max_m': round(transform['max_m'], 2) if transform.get('max_m') is not None else None,
            'n_gcp': transform.get('n_gcp'),
            'shape_coverage_ratio': round(transform['coverage_ratio'], 3) if 'coverage_ratio' in transform else None,
            'confidence': transform.get('confidence'),
            'n_methods_agreeing': transform.get('n_methods_agreeing'),
            'rotation_agreement': transform.get('rotation_agreement')},
        '_edit': {'source': 'rapa-dxf-extract', 'editedAt': now, 'buildingCount': len(buildings)},
    }

def leaflet_html(data, title):
    payload = json.dumps(data, ensure_ascii=False)
    return ("""<!DOCTYPE html><html><head><meta charset="utf-8"><title>""" + title + """</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>html,body,#map{height:100%;margin:0}#p{position:absolute;top:10px;right:10px;z-index:1000;background:#fff;padding:10px;border-radius:8px;font:13px sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.3)}
.lb{font-weight:700;font-size:11px;text-shadow:0 0 3px #fff,0 0 3px #fff}</style></head><body>
<div id="map"></div><div id="p"><b>""" + title + """</b><br>투명도 <input id="op" type="range" min="0" max="100" value="55">
<br><label><input id="sat" type="checkbox"> 위성</label></div><script>
const d=""" + payload + """;
const map=L.map('map');
const osm=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
const esri=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19});
sat.onchange=e=>{e.target.checked?(map.removeLayer(osm),esri.addTo(map)):(map.removeLayer(esri),osm.addTo(map))};
const g=L.featureGroup().addTo(map);
L.polygon(d.complex.polygon.map(p=>[p[1],p[0]]),{color:'#c40',weight:3,fill:false,dashArray:'8 5'}).addTo(g);
const col=f=>f>=22?'#c62828':f>=20?'#ef6c00':f>=13?'#2e7d32':'#1565c0';
d.buildings.forEach(b=>{const pl=L.polygon(b.polygon.map(q=>[q[1],q[0]]),{color:col(b.floors_above),weight:2,fillColor:col(b.floors_above),fillOpacity:.55}).addTo(g);
pl.bindPopup(`<b>${b.bld_nm}</b><br>${b.floors_above}F/B${b.floors_below}<br>중계장치 ${b.rooftop_repeater_count} · 관로동 ${b.is_duct_building?'예':'아니오'}`);
L.marker([b.center[1],b.center[0]],{icon:L.divIcon({className:'lb',html:b.bld_nm})}).addTo(g);});
op.oninput=e=>{const v=e.target.value/100;g.eachLayer(l=>{if(l.setStyle&&l.options.fillOpacity!==undefined)l.setStyle({fillOpacity:v})})};
map.fitBounds(g.getBounds().pad(.15));</script></body></html>""")
