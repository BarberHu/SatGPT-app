import unittest
from unittest.mock import patch
from types import SimpleNamespace
from harness.app import gee_worker
from harness.app.layer_details import layer_metadata, legend_labels

class LayerCardTests(unittest.TestCase):
 def test_metadata_bounds_and_legend_come_from_the_layer_operation(self):
  image=SimpleNamespace(getMapId=lambda options:{'mapid':'projects/p/maps/m'})
  thumbnail={'url':'/api/previews/test.png','width':256,'height':256}
  payload={'project':'p','layer_code':'result = ee.Image(1)','bounds':[119,30,120,31],
   'visualization':{'name':'Water','min':0,'max':1,'palette':['ffffff','0000ff']},
   'metadata':{'source':'Test source','observed_at':'2024-07-15','unit':'class'},
   'legend':{'type':'categorical','labels':['其他','水体']}}
  with patch.object(gee_worker,'earth_engine',return_value=object()),patch.object(gee_worker,'run_code',return_value=image),patch.object(gee_worker,'save_thumbnail',return_value=thumbnail) as generate:
   result=gee_worker.execute(payload)['layer']
  self.assertEqual(result['thumbnail'],thumbnail)
  self.assertEqual(result['metadata']['observed_at'],'2024-07-15')
  self.assertEqual(result['legend']['labels'],['其他','水体'])
  self.assertEqual(result['bounds'],payload['bounds'])
  self.assertEqual(generate.call_args.args[1],{'min':0,'max':1,'palette':['ffffff','0000ff']})
 def test_thumbnail_failure_does_not_discard_map_and_no_dates_are_invented(self):
  image=SimpleNamespace(getMapId=lambda options:{'mapid':'projects/p/maps/m'})
  with patch.object(gee_worker,'earth_engine',return_value=object()),patch.object(gee_worker,'run_code',return_value=image),patch.object(gee_worker,'save_thumbnail',side_effect=TimeoutError('no preview')):
   layer=gee_worker.execute({'project':'p','layer_code':'result = ee.Image(1)','bounds':[119,30,120,31]})['layer']
  self.assertEqual(layer['thumbnail_status'],'unavailable');self.assertIn('/tiles/',layer['url'])
  self.assertNotIn('observed_at',layer['metadata']);self.assertNotIn('thumbnail',layer)
 def test_class_labels_cannot_override_actual_palette_range(self):
  labels={'type':'categorical','labels':['a','b']}
  self.assertIsNone(legend_labels(labels,{'min':0,'max':100,'palette':['fff','00f']}))
  self.assertIsNone(legend_labels(labels,{'min':0,'max':1,'palette':['00f']}))
  self.assertEqual(legend_labels(labels,{'min':0,'max':1,'palette':['fff','00f']}),labels)
  self.assertIsNone(legend_labels(labels,{'min':float('nan'),'max':1,'palette':['fff','00f']}))
  self.assertEqual(layer_metadata({'unit':' m ','ignored':'not retained'})['unit'],'m')

if __name__=='__main__':unittest.main()
