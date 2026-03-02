"""
Google Earth Engine 服务模块
用于获取 Sentinel-1 和 Sentinel-2 卫星影像

参考实现: test.ipynb
- 使用 ee.Initialize(project='flood-agent') 初始化
- 使用 mapid['tile_fetcher'].url_format 获取瓦片URL
- 瓦片URL格式: https://earthengine.googleapis.com/v1/projects/flood-agent/maps/.../tiles/{z}/{x}/{y}
"""
import os
import ee
from typing import Optional, Dict, Any, Tuple
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

# 设置代理（如果配置了的话）
http_proxy = os.getenv("HTTP_PROXY") or os.getenv("HTTPS_PROXY")
if http_proxy:
    os.environ["HTTP_PROXY"] = http_proxy
    os.environ["HTTPS_PROXY"] = http_proxy
    print(f"🌐 使用代理: {http_proxy}")


class GEEService:
    """Google Earth Engine 服务类"""
    
    def __init__(self):
        self.initialized = False
        # 支持两种环境变量名: GEE_PROJECT_ID 或 PROJECT_ID
        self.project_id = os.getenv("GEE_PROJECT_ID") or os.getenv("PROJECT_ID", "flood-agent")
        self._initialize_ee()
    
    def _initialize_ee(self):
        """初始化 Earth Engine - 与 test.ipynb 保持一致"""
        try:
            credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            
            if credentials_path and os.path.exists(credentials_path):
                # 使用服务账户凭证
                credentials = ee.ServiceAccountCredentials(
                    email=None,
                    key_file=credentials_path
                )
                ee.Initialize(credentials, project=self.project_id)
                print(f"✅ Earth Engine 使用服务账户初始化成功 (project: {self.project_id})")
            else:
                # 使用默认认证 (需要先运行 ee.Authenticate())
                ee.Initialize(project=self.project_id)
                print(f"✅ Earth Engine 使用默认认证初始化成功 (project: {self.project_id})")
            
            self.initialized = True
        except Exception as e:
            print(f"❌ Earth Engine 初始化失败: {e}")
            print("提示: 请确保已设置 GOOGLE_APPLICATION_CREDENTIALS 或先运行 ee.Authenticate()")
            self.initialized = False
    
    def _get_collection_date_range(self, collection: ee.ImageCollection) -> Dict[str, Any]:
        """获取影像集合的日期范围"""
        try:
            # 获取最早和最晚的影像日期
            sorted_asc = collection.sort("system:time_start")
            sorted_desc = collection.sort("system:time_start", False)
            
            first_image = sorted_asc.first()
            last_image = sorted_desc.first()
            
            first_ts = first_image.get("system:time_start").getInfo()
            last_ts = last_image.get("system:time_start").getInfo()
            
            first_date = datetime.fromtimestamp(first_ts / 1000).strftime("%Y-%m-%d")
            last_date = datetime.fromtimestamp(last_ts / 1000).strftime("%Y-%m-%d")
            
            if first_date == last_date:
                return {"date_range": first_date, "is_single_date": True}
            else:
                return {"date_range": f"{first_date} ~ {last_date}", "is_single_date": False}
        except:
            return {"date_range": None, "is_single_date": None}
    
    def get_sentinel2_image(
        self,
        date: str,
        bounds: Dict[str, float],
        cloud_cover_max: int = 30,
        days_range: int = 15
    ) -> Optional[Dict[str, Any]]:
        """
        获取 Sentinel-2 光学影像
        
        Args:
            date: 目标日期 (YYYY-MM-DD)
            bounds: 边界框 {"west": lon, "south": lat, "east": lon, "north": lat}
            cloud_cover_max: 最大云量百分比
            days_range: 日期搜索范围（前后天数）
            
        Returns:
            包含影像URL和元数据的字典
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            # 解析日期
            target_date = datetime.strptime(date, "%Y-%m-%d")
            start_date = (target_date - timedelta(days=days_range)).strftime("%Y-%m-%d")
            end_date = (target_date + timedelta(days=days_range)).strftime("%Y-%m-%d")
            
            # 创建区域
            region = ee.Geometry.Rectangle([
                bounds["west"], bounds["south"],
                bounds["east"], bounds["north"]
            ])
            
            # 获取 Sentinel-2 影像集合
            s2_collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED") \
                .filterDate(start_date, end_date) \
                .filterBounds(region) \
                .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", cloud_cover_max)) \
                .sort("CLOUDY_PIXEL_PERCENTAGE")
            
            # 检查是否有影像
            count = s2_collection.size().getInfo()
            if count == 0:
                return {"error": f"No Sentinel-2 imagery found near {date}"}
            
            # 使用镜嵌合成解决跨幅问题
            # mosaic() 会将多幅影像合并，后面的影像覆盖前面的
            # 由于已按云量排序，云量最少的影像会在最上层
            mosaic_image = s2_collection.mosaic().clip(region)
            
            # 选择真彩色波段
            rgb_image = mosaic_image.select(["B4", "B3", "B2"])
            
            # 可视化参数
            vis_params = {
                "min": 0,
                "max": 3000
            }
            
            # 获取瓦片URL (与 test.ipynb 一致的方式)
            map_id = rgb_image.getMapId(vis_params)
            tile_url = map_id["tile_fetcher"].url_format
            
            # 获取影像信息 (使用第一幅影像的元数据作为参考)
            first_image = s2_collection.first()
            info = first_image.getInfo()
            properties = info.get("properties", {})
            
            # 安全获取日期
            generation_time = properties.get("GENERATION_TIME")
            if generation_time and isinstance(generation_time, str):
                image_date = generation_time[:10]
            else:
                # 尝试从时间戳获取
                timestamp = properties.get("system:time_start")
                if timestamp:
                    image_date = datetime.fromtimestamp(timestamp / 1000).strftime("%Y-%m-%d")
                else:
                    image_date = date
            
            return {
                "type": "Sentinel-2",
                "tile_url": tile_url,
                "date": image_date,
                "cloud_cover": properties.get("CLOUDY_PIXEL_PERCENTAGE", 0),
                "spacecraft": properties.get("SPACECRAFT_NAME", "unknown"),
                "mgrs_tile": properties.get("MGRS_TILE", ""),
                "id": info.get("id", "unknown"),
                "mosaic": count > 1,  # 标识是否使用了镜嵌
                "image_count": count
            }
            
        except Exception as e:
            return {"error": f"Failed to retrieve Sentinel-2 imagery: {str(e)}"}
    
    def get_sentinel1_image(
        self,
        date: str,
        bounds: Dict[str, float],
        days_range: int = 15,
        polarization: str = "VV"
    ) -> Optional[Dict[str, Any]]:
        """
        获取 Sentinel-1 SAR雷达影像
        
        Args:
            date: 目标日期 (YYYY-MM-DD)
            bounds: 边界框
            days_range: 日期搜索范围
            polarization: 极化方式 (VV 或 VH)
            
        Returns:
            包含影像URL和元数据的字典
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            # 解析日期
            target_date = datetime.strptime(date, "%Y-%m-%d")
            start_date = (target_date - timedelta(days=days_range)).strftime("%Y-%m-%d")
            end_date = (target_date + timedelta(days=days_range)).strftime("%Y-%m-%d")
            
            # 创建区域
            region = ee.Geometry.Rectangle([
                bounds["west"], bounds["south"],
                bounds["east"], bounds["north"]
            ])
            
            # 获取 Sentinel-1 影像集合 (与 test.ipynb 一致)
            s1_collection = ee.ImageCollection("COPERNICUS/S1_GRD") \
                .filterDate(start_date, end_date) \
                .filterBounds(region) \
                .filter(ee.Filter.listContains("transmitterReceiverPolarisation", polarization)) \
                .filter(ee.Filter.eq("instrumentMode", "IW")) \
                .select(polarization)
            
            # 检查是否有影像
            count = s1_collection.size().getInfo()
            if count == 0:
                return {"error": f"No Sentinel-1 imagery found near {date}"}
            
            # 使用镜嵌合成解决跨幅问题
            # 对于 SAR 影像，镜嵌是合适的方法
            mosaic_image = s1_collection.mosaic().clip(region)
            
            # 可视化参数（SAR影像通常在-25到0 dB范围）
            vis_params = {
                "min": -25,
                "max": 0
            }
            
            # 获取瓦片URL
            map_id = mosaic_image.getMapId(vis_params)
            tile_url = map_id["tile_fetcher"].url_format
            
            # 获取影像信息 (使用第一幅影像的元数据作为参考)
            first_image = s1_collection.sort("system:time_start").first()
            info = first_image.getInfo()
            properties = info.get("properties", {})
            timestamp = properties.get("system:time_start", 0)
            image_date = datetime.fromtimestamp(timestamp / 1000).strftime("%Y-%m-%d") if timestamp else date
            
            return {
                "type": "Sentinel-1",
                "polarization": polarization,
                "tile_url": tile_url,
                "date": image_date,
                "id": info.get("id", "unknown"),
                "spacecraft": f"Sentinel-1{properties.get('platform_number', '')}",
                "orbit_pass": properties.get("orbitProperties_pass", "unknown"),
                "resolution": properties.get("resolution_meters", ""),
                "mosaic": count > 1,  # 标识是否使用了镜嵌
                "image_count": count
            }
            
        except Exception as e:
            return {"error": f"Failed to retrieve Sentinel-1 imagery: {str(e)}"}
    
    def get_flood_imagery(
        self,
        pre_date: str,
        peek_date: str,
        after_date: str,
        center: Tuple[float, float],
        buffer_km: float = 50
    ) -> Dict[str, Any]:
        """
        获取洪水事件的完整影像集
        
        Args:
            pre_date: 洪水前日期
            peek_date: 洪峰日期
            after_date: 洪水后日期
            center: 中心点坐标 (longitude, latitude)
            buffer_km: 缓冲区半径（公里）
            
        Returns:
            包含所有时期影像的字典
        """
        # 计算边界框
        lat_buffer = buffer_km / 111  # 1度约111公里
        lon_buffer = buffer_km / (111 * abs(center[1]) if center[1] != 0 else 111)
        
        bounds = {
            "west": center[0] - lon_buffer,
            "south": center[1] - lat_buffer,
            "east": center[0] + lon_buffer,
            "north": center[1] + lat_buffer
        }
        
        return self._get_imagery_for_bounds(pre_date, peek_date, after_date, bounds, center)
    
    def get_flood_imagery_by_bounds(
        self,
        pre_date: str,
        peek_date: str,
        after_date: str,
        bounds: Dict[str, float],
        center: Optional[Tuple[float, float]] = None
    ) -> Dict[str, Any]:
        """
        使用边界框获取洪水事件的完整影像集
        
        Args:
            pre_date: 洪水前日期
            peek_date: 洪峰日期
            after_date: 洪水后日期
            bounds: 边界框 {"west", "south", "east", "north"}
            center: 中心点坐标（可选）
            
        Returns:
            包含所有时期影像的字典
        """
        if center is None:
            # 计算中心点
            center = (
                (bounds["west"] + bounds["east"]) / 2,
                (bounds["south"] + bounds["north"]) / 2
            )
        
        return self._get_imagery_for_bounds(pre_date, peek_date, after_date, bounds, center)
    
    def get_flood_imagery_by_geojson(
        self,
        pre_date: str,
        peek_date: str,
        after_date: str,
        geojson: Dict[str, Any],
        center: Optional[Tuple[float, float]] = None
    ) -> Dict[str, Any]:
        """
        使用 GeoJSON 边界获取洪水事件的完整影像集
        
        Args:
            pre_date: 洪水前日期
            peek_date: 洪峰日期
            after_date: 洪水后日期
            geojson: GeoJSON 对象
            center: 中心点坐标（可选）
            
        Returns:
            包含所有时期影像的字典
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            # 将 GeoJSON 转换为 EE Geometry
            region = ee.Geometry(geojson)
            
            # 获取边界框
            bounds_list = region.bounds().getInfo()["coordinates"][0]
            bounds = {
                "west": min(p[0] for p in bounds_list),
                "south": min(p[1] for p in bounds_list),
                "east": max(p[0] for p in bounds_list),
                "north": max(p[1] for p in bounds_list)
            }
            
            if center is None:
                center = (
                    (bounds["west"] + bounds["east"]) / 2,
                    (bounds["south"] + bounds["north"]) / 2
                )
            
            result = {
                "center": center,
                "bounds": bounds,
                "pre_date": {},
                "peek_date": {},
                "after_date": {}
            }
            
            # 获取各时期的影像
            for date_key, date_value in [
                ("pre_date", pre_date),
                ("peek_date", peek_date),
                ("after_date", after_date)
            ]:
                if date_value:
                    # 使用 GeoJSON region 获取影像
                    s2_result = self._get_sentinel2_by_region(date_value, region)
                    result[date_key]["sentinel2"] = s2_result
                    
                    s1_result = self._get_sentinel1_by_region(date_value, region)
                    result[date_key]["sentinel1"] = s1_result
            
            # 添加 Otsu 洪水变化检测图层
            if pre_date and peek_date:
                flood_detection = self.get_flood_change_detection_by_geojson(
                    pre_date, peek_date, geojson
                )
                result["flood_detection"] = flood_detection
            
            return result
            
        except Exception as e:
            return {"error": f"GeoJSON processing failed: {str(e)}"}
    
    def _get_imagery_for_bounds(
        self,
        pre_date: str,
        peek_date: str,
        after_date: str,
        bounds: Dict[str, float],
        center: Tuple[float, float]
    ) -> Dict[str, Any]:
        """内部方法：根据边界框获取影像"""
        result = {
            "center": center,
            "bounds": bounds,
            "pre_date": {},
            "peek_date": {},
            "after_date": {}
        }
        
        # 获取各时期的影像
        for date_key, date_value in [
            ("pre_date", pre_date),
            ("peek_date", peek_date),
            ("after_date", after_date)
        ]:
            if date_value:
                # Sentinel-2 光学影像
                s2_result = self.get_sentinel2_image(date_value, bounds)
                result[date_key]["sentinel2"] = s2_result
                
                # Sentinel-1 SAR影像
                s1_result = self.get_sentinel1_image(date_value, bounds)
                result[date_key]["sentinel1"] = s1_result
        
        # 添加 SAR 变化检测图层 (与 test.ipynb 一致)
        if pre_date and after_date:
            sar_change = self._get_sar_change_tile(pre_date, after_date, bounds)
            result["sar_change"] = sar_change
        
        # 添加 Otsu 洪水变化检测图层
        if pre_date and peek_date:
            flood_detection = self.get_flood_change_detection(pre_date, peek_date, bounds)
            result["flood_detection"] = flood_detection
        
        return result
    
    def _get_sar_change_tile(
        self,
        date_start: str,
        date_end: str,
        bounds: Dict[str, float],
        polarization: str = "VV"
    ) -> Dict[str, Any]:
        """
        获取 SAR 变化检测图层的瓦片URL
        与 test.ipynb 中的实现保持一致
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            # 创建区域
            region = ee.Geometry.Rectangle([
                bounds["west"], bounds["south"],
                bounds["east"], bounds["north"]
            ])
            
            # 创建图像集合 (与 test.ipynb 一致)
            collection = ee.ImageCollection("COPERNICUS/S1_GRD") \
                .filterDate(date_start, date_end) \
                .filterBounds(region) \
                .filter(ee.Filter.listContains("transmitterReceiverPolarisation", polarization)) \
                .filter(ee.Filter.eq("instrumentMode", "IW")) \
                .select(polarization)
            
            # 使用时间中点划分前后 (与 test.ipynb 一致)
            date_start_ee = ee.Date(date_start)
            date_end_ee = ee.Date(date_end)
            mid_date = date_start_ee.advance(
                date_end_ee.difference(date_start_ee, 'day').divide(2), 'day'
            )
            
            # 计算前后时期的中值影像
            before = collection.filterDate(date_start_ee, mid_date).median()
            after = collection.filterDate(mid_date, date_end_ee).median()
            
            # 计算差值
            diff = after.subtract(before).rename(f'{polarization}_diff')
            
            # 裁剪到区域 (与 test.ipynb 一致)
            diff_clipped = diff.clip(region)
            
            # 可视化参数 (与 test.ipynb 一致: 蓝-白-红)
            viz_params = {
                "min": -5,
                "max": 5,
                "palette": ["blue", "white", "red"]
            }
            
            # 获取瓦片URL (与 test.ipynb 完全一致的方式)
            map_id = diff_clipped.getMapId(viz_params)
            tile_url = map_id["tile_fetcher"].url_format
            
            return {
                "type": "SAR-Change",
                "polarization": polarization,
                "tile_url": tile_url,
                "date_start": date_start,
                "date_end": date_end,
                "description": "蓝色=减少, 白色=无变化, 红色=增加"
            }
            
        except Exception as e:
            return {"error": f"Failed to retrieve SAR change detection layer: {str(e)}"}
    
    def _get_sentinel2_by_region(
        self,
        date: str,
        region: ee.Geometry,
        cloud_cover_max: int = 30,
        days_range: int = 15
    ) -> Optional[Dict[str, Any]]:
        """使用 EE Geometry 获取 Sentinel-2 影像"""
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            target_date = datetime.strptime(date, "%Y-%m-%d")
            start_date = (target_date - timedelta(days=days_range)).strftime("%Y-%m-%d")
            end_date = (target_date + timedelta(days=days_range)).strftime("%Y-%m-%d")
            
            s2_collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED") \
                .filterDate(start_date, end_date) \
                .filterBounds(region) \
                .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", cloud_cover_max)) \
                .sort("CLOUDY_PIXEL_PERCENTAGE")
            
            # 检查是否有影像
            count = s2_collection.size().getInfo()
            if count == 0:
                return {
                    "error": f"No Sentinel-2 imagery found near {date}",
                    "type": "Sentinel-2",
                    "requested_date": date,
                    "search_range": f"{start_date} ~ {end_date}",
                    "image_count": 0
                }
            
            # 获取所有影像的日期范围
            dates_info = self._get_collection_date_range(s2_collection)
            
            # 使用镶嵌合成解决跨幅问题
            mosaic_image = s2_collection.mosaic().clip(region)
            rgb_image = mosaic_image.select(["B4", "B3", "B2"])
            
            vis_params = {
                "min": 0,
                "max": 3000
            }
            
            # 获取瓦片URL
            map_id = rgb_image.getMapId(vis_params)
            tile_url = map_id["tile_fetcher"].url_format
            
            # 使用第一幅影像的元数据作为参考
            first_image = s2_collection.first()
            info = first_image.getInfo()
            properties = info.get("properties", {})
            
            # 安全获取日期
            generation_time = properties.get("GENERATION_TIME")
            if generation_time and isinstance(generation_time, str):
                image_date = generation_time[:10]
            else:
                timestamp = properties.get("system:time_start")
                if timestamp:
                    image_date = datetime.fromtimestamp(timestamp / 1000).strftime("%Y-%m-%d")
                else:
                    image_date = date
            
            return {
                "type": "Sentinel-2",
                "tile_url": tile_url,
                "date": image_date,
                "requested_date": date,
                "search_range": f"{start_date} ~ {end_date}",
                "actual_date_range": dates_info.get("date_range"),
                "cloud_cover": properties.get("CLOUDY_PIXEL_PERCENTAGE", 0),
                "spacecraft": properties.get("SPACECRAFT_NAME", "unknown"),
                "mgrs_tile": properties.get("MGRS_TILE", ""),
                "id": info.get("id", "unknown"),
                "mosaic": count > 1,
                "image_count": count
            }
            
        except Exception as e:
            return {"error": f"Failed to retrieve Sentinel-2 imagery: {str(e)}"}
    
    def _get_sentinel1_by_region(
        self,
        date: str,
        region: ee.Geometry,
        days_range: int = 15,
        polarization: str = "VV"
    ) -> Optional[Dict[str, Any]]:
        """使用 EE Geometry 获取 Sentinel-1 影像"""
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            target_date = datetime.strptime(date, "%Y-%m-%d")
            start_date = (target_date - timedelta(days=days_range)).strftime("%Y-%m-%d")
            end_date = (target_date + timedelta(days=days_range)).strftime("%Y-%m-%d")
            
            s1_collection = ee.ImageCollection("COPERNICUS/S1_GRD") \
                .filterDate(start_date, end_date) \
                .filterBounds(region) \
                .filter(ee.Filter.listContains("transmitterReceiverPolarisation", polarization)) \
                .filter(ee.Filter.eq("instrumentMode", "IW")) \
                .select(polarization)
            
            # 检查是否有影像
            count = s1_collection.size().getInfo()
            if count == 0:
                return {
                    "error": f"No Sentinel-1 imagery found near {date}",
                    "type": "Sentinel-1",
                    "requested_date": date,
                    "search_range": f"{start_date} ~ {end_date}",
                    "image_count": 0
                }
            
            # 获取所有影像的日期范围
            dates_info = self._get_collection_date_range(s1_collection)
            
            # 使用镶嵌合成解决跨幅问题
            mosaic_image = s1_collection.mosaic().clip(region)
            
            vis_params = {
                "min": -25,
                "max": 0
            }
            
            # 获取瓦片URL
            map_id = mosaic_image.getMapId(vis_params)
            tile_url = map_id["tile_fetcher"].url_format
            
            # 使用第一幅影像的元数据作为参考
            first_image = s1_collection.sort("system:time_start").first()
            info = first_image.getInfo()
            properties = info.get("properties", {})
            timestamp = properties.get("system:time_start", 0)
            image_date = datetime.fromtimestamp(timestamp / 1000).strftime("%Y-%m-%d") if timestamp else date
            
            return {
                "type": "Sentinel-1",
                "polarization": polarization,
                "tile_url": tile_url,
                "date": image_date,
                "requested_date": date,
                "search_range": f"{start_date} ~ {end_date}",
                "actual_date_range": dates_info.get("date_range"),
                "id": info.get("id", "unknown"),
                "spacecraft": f"Sentinel-1{properties.get('platform_number', '')}",
                "orbit_pass": properties.get("orbitProperties_pass", "unknown"),
                "resolution": properties.get("resolution_meters", ""),
                "mosaic": count > 1,
                "image_count": count
            }
            
        except Exception as e:
            return {"error": f"Failed to retrieve Sentinel-1 imagery: {str(e)}"}
    
    def get_flood_change_detection(
        self,
        pre_date: str,
        peek_date: str,
        bounds: Dict[str, float],
        days_range: int = 15
    ) -> Dict[str, Any]:
        """
        基于 Otsu 变化检测的洪水提取方法
        
        标准Otsu变化检测流程:
        1. 获取洪水前和洪峰期的SAR影像
        2. 计算变化指数 (差值法: peek - pre, dB域下相当于对数比值)
        3. 对变化指数应用Otsu阈值分割
        4. 变化指数为负值(后向散射降低)的区域为新增水体
        5. 结合JRC永久水体数据排除已有水体
        
        Args:
            pre_date: 洪水前日期 (YYYY-MM-DD)
            peek_date: 洪峰日期 (YYYY-MM-DD)
            bounds: 边界框 {"west", "south", "east", "north"}
            days_range: 日期搜索范围（前后天数）
            
        Returns:
            包含变化检测图层URL的字典
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            # 创建区域
            region = ee.Geometry.Rectangle([
                bounds["west"], bounds["south"],
                bounds["east"], bounds["north"]
            ])
            
            # 获取洪水前和洪峰期的SAR影像
            # 关键：确保两个时期的影像时间窗口不重叠
            # pre_date 只向前搜索，peek_date 只向后搜索
            pre_image = self._get_sar_composite(pre_date, region, days_range, search_direction="before")
            peek_image = self._get_sar_composite(peek_date, region, days_range, search_direction="after")
            
            if pre_image is None or peek_image is None:
                return {"error": "Insufficient SAR imagery for change detection"}
            
            # === 标准Otsu变化检测方法 ===
            # 步骤1: 计算变化指数 (dB差值 = log(peek/pre))
            # 水体后向散射降低, 所以洪水区域的变化指数为负值
            vv_pre = pre_image.select("VV")
            vv_peek = peek_image.select("VV")
            
            # dB域下的差值 = peek_dB - pre_dB = 10*log10(peek/pre)
            # 负值表示后向散射降低（可能是新增水体）
            change_index = vv_peek.subtract(vv_pre).rename("change")
            
            # 步骤2: 对变化指数应用Otsu阈值（检测变化区域）
            flood_by_change = self._otsu_change_detection(change_index, region)
            
            # 步骤3: 同时检测洪峰期水体（确保不漏掉）
            # 使用传统Otsu方法检测洪峰期的所有水体
            peek_water = self._otsu_water_detection(peek_image, region)
            
            # 步骤4: 使用 JRC Global Surface Water 排除永久水体
            # 只排除真正的永久水体（occurrence >= 95，即几乎始终有水）
            jrc = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").clip(region)
            permanent_water = jrc.select("occurrence").gte(95)
            
            # 洪水淹没区 = (变化检测结果 OR 洪峰期水体) AND 不是永久水体
            # 这样既能检测到新增水体，也不会漏掉洪峰期的水体
            flood_area = (flood_by_change.Or(peek_water)).And(permanent_water.Not())
            
            # 只显示洪水淹没区（红色）
            flood_map = flood_area.selfMask().clip(region)
            
            # 可视化参数 - 只有洪水淹没区（红色）
            viz_params = {
                "min": 0,
                "max": 1,
                "palette": ["ff0000"]  # 红色
            }
            
            map_id = flood_map.getMapId(viz_params)
            tile_url = map_id["tile_fetcher"].url_format
            
            # 计算面积统计
            stats = self._calculate_flood_stats(flood_area, region)
            
            return {
                "type": "flood-change-detection",
                "method": "Otsu变化检测",
                "tile_url": tile_url,
                "pre_date": pre_date,
                "peek_date": peek_date,
                "legend": {
                    "flood_area": {"color": "#ff0000", "label": "洪水淹没区"}
                },
                "stats": stats,
                "description": "基于SAR变化指数的Otsu阈值分割，红色=洪水淹没区"
            }
            
        except Exception as e:
            return {"error": f"Flood change detection failed: {str(e)}"}
    
    def get_flood_change_detection_by_geojson( # 顶层函数
        self,
        pre_date: str,
        peek_date: str,
        geojson: Dict[str, Any],
        days_range: int = 15
    ) -> Dict[str, Any]:
        """
        基于 GeoJSON 边界的洪水变化检测 (标准Otsu变化检测方法)
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            region = ee.Geometry(geojson)
            
            # 获取边界框用于返回
            bounds_list = region.bounds().getInfo()["coordinates"][0]
            bounds = {
                "west": min(p[0] for p in bounds_list),
                "south": min(p[1] for p in bounds_list),
                "east": max(p[0] for p in bounds_list),
                "north": max(p[1] for p in bounds_list)
            }
            
            # 获取洪水前和洪峰期的SAR影像
            # 关键：确保两个时期的影像时间窗口不重叠
            pre_image = self._get_sar_composite(pre_date, region, days_range, search_direction="before")
            peek_image = self._get_sar_composite(peek_date, region, days_range, search_direction="after")
            
            if pre_image is None or peek_image is None:
                return {"error": "Insufficient SAR imagery for change detection"}
            
            # === 标准Otsu变化检测方法 ===
            # 计算变化指数 (dB差值)
            vv_pre = pre_image.select("VV")
            vv_peek = peek_image.select("VV")
            change_index = vv_peek.subtract(vv_pre).rename("change")
            
            # 对变化指数应用Otsu阈值（检测变化区域）
            flood_by_change = self._otsu_change_detection(change_index, region)
            
            # 同时检测洪峰期水体（确保不漏掉）
            peek_water = self._otsu_water_detection(peek_image, region)
            
            # 使用 JRC Global Surface Water 排除永久水体
            # 只排除真正的永久水体（occurrence >= 95）
            jrc = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").clip(region)
            permanent_water = jrc.select("occurrence").gte(95)
            
            # 洪水淹没区 = (变化检测结果 OR 洪峰期水体) AND 不是永久水体
            flood_area = (flood_by_change.Or(peek_water)).And(permanent_water.Not())
            
            # 只显示洪水淹没区
            flood_map = flood_area.selfMask().clip(region)
            
            viz_params = {
                "min": 0,
                "max": 1,
                "palette": ["ff0000"]
            }
            
            map_id = flood_map.getMapId(viz_params)
            tile_url = map_id["tile_fetcher"].url_format
            
            stats = self._calculate_flood_stats(flood_area, region)
            
            return {
                "type": "flood-change-detection",
                "method": "Otsu变化检测",
                "tile_url": tile_url,
                "bounds": bounds,
                "pre_date": pre_date,
                "peek_date": peek_date,
                "legend": {
                    "flood_area": {"color": "#ff0000", "label": "洪水淹没区"}
                },
                "stats": stats,
                "description": "基于SAR变化指数的Otsu阈值分割，红色=洪水淹没区"
            }
            
        except Exception as e:
            return {"error": f"Flood change detection failed: {str(e)}"}
    
    def _get_sar_composite(
        self,
        date: str,
        region: ee.Geometry,
        days_range: int = 15,
        search_direction: str = "both"
    ) -> Optional[ee.Image]:
        """
        获取指定日期附近的 SAR 影像合成
        使用中值合成减少斑点噪声
        
        Args:
            date: 目标日期
            region: 区域
            days_range: 搜索天数范围
            search_direction: 搜索方向
                - "both": 前后各 days_range 天（默认）
                - "before": 只搜索目标日期之前
                - "after": 只搜索目标日期之后
        """
        try:
            target_date = datetime.strptime(date, "%Y-%m-%d")
            
            if search_direction == "before":
                # 只搜索目标日期之前的影像
                start_date = (target_date - timedelta(days=days_range)).strftime("%Y-%m-%d")
                end_date = date  # 截止到目标日期（不包含）
            elif search_direction == "after":
                # 只搜索目标日期之后的影像
                start_date = date
                end_date = (target_date + timedelta(days=days_range)).strftime("%Y-%m-%d")
            else:
                # 前后各搜索 days_range 天
                start_date = (target_date - timedelta(days=days_range)).strftime("%Y-%m-%d")
                end_date = (target_date + timedelta(days=days_range)).strftime("%Y-%m-%d")
            
            # 获取 VV 和 VH 极化的 SAR 影像
            s1_collection = ee.ImageCollection("COPERNICUS/S1_GRD") \
                .filterDate(start_date, end_date) \
                .filterBounds(region) \
                .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV")) \
                .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH")) \
                .filter(ee.Filter.eq("instrumentMode", "IW")) \
                .select(["VV", "VH"])
            
            count = s1_collection.size().getInfo()
            if count == 0:
                return None
            
            # 使用中值合成减少斑点噪声
            composite = s1_collection.median().clip(region)
            
            return composite
            
        except Exception as e:
            print(f"Failed to get SAR composite: {e}")
            return None
    
    def _otsu_water_detection(
        self,
        image: ee.Image,
        region: ee.Geometry
    ) -> ee.Image:
        """
        使用 Otsu 阈值法进行水体检测
        
        Otsu 算法通过最大化类间方差自动确定最佳阈值
        对于 SAR 影像，水体通常呈现低后向散射（暗色调）
        
        Args:
            image: SAR 影像 (包含 VV 波段)
            region: 分析区域
            
        Returns:
            水体掩膜 (1=水体, 0=非水体)
        """
        # 使用 VV 极化进行水体检测（水体在VV极化下后向散射更低）
        vv = image.select("VV")
        
        # 计算 Otsu 阈值
        # 使用直方图计算最佳分割阈值
        histogram = vv.reduceRegion(
            reducer=ee.Reducer.histogram(255, 0.1),
            geometry=region,
            scale=30,  # 使用较粗的分辨率加速计算
            maxPixels=1e9,
            bestEffort=True
        )
        
        # 从直方图计算 Otsu 阈值
        threshold = self._compute_otsu_threshold(histogram.get("VV"))
        
        # 应用阈值检测水体 (低于阈值的为水体)
        water_mask = vv.lt(threshold).rename('water')
        
        return water_mask
    
    def _compute_otsu_threshold(self, histogram: ee.Dictionary) -> ee.Number:
        """
        从直方图计算 Otsu 阈值
        
        Otsu 方法通过最大化类间方差来确定最优阈值
        """
        # 获取直方图数据
        counts = ee.Array(ee.Dictionary(histogram).get("histogram"))
        means = ee.Array(ee.Dictionary(histogram).get("bucketMeans"))
        
        # 计算总像素数和总和
        size = means.length().get([0])
        total = counts.reduce(ee.Reducer.sum(), [0]).get([0])
        
        # 计算所有像素的加权和
        sum_all = counts.multiply(means).reduce(ee.Reducer.sum(), [0]).get([0])
        
        # Otsu 算法实现
        # 使用 GEE 的 iterate 方法遍历所有可能的阈值
        def otsu_iteration(i, state):
            state = ee.Dictionary(state)
            i = ee.Number(i)
            
            # 当前阈值左侧的权重和均值
            w0 = state.getNumber("w0").add(counts.get([i]))
            sum0 = state.getNumber("sum0").add(counts.get([i]).multiply(means.get([i])))
            
            # 计算类间方差
            w1 = total.subtract(w0)
            
            # 避免除零
            valid = w0.gt(0).And(w1.gt(0))
            
            mean0 = sum0.divide(w0)
            mean1 = sum_all.subtract(sum0).divide(w1)
            
            # 类间方差 = w0 * w1 * (mean0 - mean1)^2
            between_var = valid.multiply(
                w0.multiply(w1).multiply(mean0.subtract(mean1).pow(2))
            )
            
            # 更新最大方差和对应阈值
            max_var = state.getNumber("max_var")
            best_threshold = state.getNumber("best_threshold")
            
            new_max = between_var.gt(max_var)
            max_var = new_max.multiply(between_var).add(new_max.Not().multiply(max_var))
            best_threshold = new_max.multiply(means.get([i])).add(new_max.Not().multiply(best_threshold))
            
            return ee.Dictionary({
                "w0": w0,
                "sum0": sum0,
                "max_var": max_var,
                "best_threshold": best_threshold
            })
        
        # 初始状态
        initial_state = ee.Dictionary({
            "w0": ee.Number(0),
            "sum0": ee.Number(0),
            "max_var": ee.Number(0),
            "best_threshold": ee.Number(-20)  # SAR 典型水体阈值
        })
        
        # 迭代计算
        result = ee.List.sequence(0, size.subtract(1)).iterate(otsu_iteration, initial_state)
        
        return ee.Dictionary(result).getNumber("best_threshold")
    
    def _otsu_change_detection(
        self,
        change_index: ee.Image,
        region: ee.Geometry
    ) -> ee.Image:
        """
        使用 Otsu 阈值法对变化指数进行分割，检测洪水区域
        
        标准Otsu变化检测方法:
        - 变化指数 = 洪峰期VV - 洪水前VV (dB域)
        - 负值表示后向散射降低，可能是新增水体
        - 使用Otsu自动确定最佳分割阈值
        
        Args:
            change_index: 变化指数影像 (peek - pre, dB域)
            region: 分析区域
            
        Returns:
            洪水掩膜 (1=洪水区域, 0=非洪水区域)
        """
        # 获取变化指数波段
        change = change_index.select("change")
        
        # 计算直方图
        # 变化指数范围大约在 -30 到 +30 dB
        histogram = change.reduceRegion(
            reducer=ee.Reducer.histogram(255, 0.2),
            geometry=region,
            scale=30,
            maxPixels=1e9,
            bestEffort=True
        )
        
        # 从直方图计算 Otsu 阈值
        threshold = self._compute_change_otsu_threshold(histogram.get("change"))
        
        # 应用阈值检测洪水区域
        # 变化指数小于阈值（后向散射显著降低）的区域为洪水
        # Otsu会自动找到最优分割点，不需要额外的min_change限制
        flood_mask = change.lt(threshold).rename('flood')
        
        return flood_mask
    
    def _compute_change_otsu_threshold(self, histogram: ee.Dictionary) -> ee.Number:
        """
        从变化指数直方图计算 Otsu 阈值
        
        专门用于变化检测的Otsu阈值计算，初始阈值设为0
        （变化指数为0表示无变化，负值表示后向散射降低）
        """
        # 获取直方图数据
        counts = ee.Array(ee.Dictionary(histogram).get("histogram"))
        means = ee.Array(ee.Dictionary(histogram).get("bucketMeans"))
        
        # 计算总像素数和总和
        size = means.length().get([0])
        total = counts.reduce(ee.Reducer.sum(), [0]).get([0])
        
        # 计算所有像素的加权和
        sum_all = counts.multiply(means).reduce(ee.Reducer.sum(), [0]).get([0])
        
        # Otsu 算法迭代
        def otsu_iteration(i, state):
            state = ee.Dictionary(state)
            i = ee.Number(i)
            
            w0 = state.getNumber("w0").add(counts.get([i]))
            sum0 = state.getNumber("sum0").add(counts.get([i]).multiply(means.get([i])))
            
            w1 = total.subtract(w0)
            valid = w0.gt(0).And(w1.gt(0))
            
            mean0 = sum0.divide(w0)
            mean1 = sum_all.subtract(sum0).divide(w1)
            
            between_var = valid.multiply(
                w0.multiply(w1).multiply(mean0.subtract(mean1).pow(2))
            )
            
            max_var = state.getNumber("max_var")
            best_threshold = state.getNumber("best_threshold")
            
            new_max = between_var.gt(max_var)
            max_var = new_max.multiply(between_var).add(new_max.Not().multiply(max_var))
            best_threshold = new_max.multiply(means.get([i])).add(new_max.Not().multiply(best_threshold))
            
            return ee.Dictionary({
                "w0": w0,
                "sum0": sum0,
                "max_var": max_var,
                "best_threshold": best_threshold
            })
        
        # 初始状态，阈值设为-3dB (变化检测的合理默认值)
        initial_state = ee.Dictionary({
            "w0": ee.Number(0),
            "sum0": ee.Number(0),
            "max_var": ee.Number(0),
            "best_threshold": ee.Number(-3)  # 变化检测默认阈值
        })
        
        result = ee.List.sequence(0, size.subtract(1)).iterate(otsu_iteration, initial_state)
        
        return ee.Dictionary(result).getNumber("best_threshold")
    
    def _calculate_flood_stats(
        self,
        flood_area: ee.Image,
        region: ee.Geometry
    ) -> Dict[str, Any]:
        """
        计算洪水统计信息
        """
        try:
            # 计算像素面积（平方公里）
            pixel_area = ee.Image.pixelArea().divide(1e6)  # 转换为平方公里
            
            # 计算洪水淹没面积
            flood_area_km2 = flood_area.multiply(pixel_area).reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=region,
                scale=30,
                maxPixels=1e9,
                bestEffort=True
            ).getInfo()
            
            # 获取第一个有效的值
            flood_val = 0
            if flood_area_km2:
                for key in flood_area_km2:
                    if flood_area_km2[key] is not None:
                        flood_val = flood_area_km2[key]
                        break
            
            return {
                "flood_area_km2": round(flood_val, 2),
                "unit": "km²"
            }
        except Exception as e:
            print(f"Failed to compute flood statistics: {e}")
            return {"error": str(e)}

    def get_flood_impact_assessment(
        self,
        flood_mask: ee.Image,
        region: ee.Geometry,
        pre_date: str,
        peek_date: str
    ) -> Dict[str, Any]:
        """
        洪水损失评估 - 结合多种开源数据
        
        使用的开源数据:
        - WorldPop: 人口密度数据
        - ESA WorldCover: 土地覆盖分类
        - JRC Global Surface Water: 历史水体数据
        - GHSL: 人类居住区数据
        
        Args:
            flood_mask: 洪水掩膜 (1=洪水淹没区, 0=非淹没区)
            region: 分析区域
            pre_date: 洪水前日期
            peek_date: 洪峰日期
            
        Returns:
            包含各类损失评估的字典
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            results: Dict[str, Any] = {
                "assessment_date": datetime.now().strftime("%Y-%m-%d %H:%M"),
                "analysis_period": f"{pre_date} to {peek_date}",
            }
            
            # 像素面积 (平方公里)
            pixel_area_km2 = ee.Image.pixelArea().divide(1e6)
            
            # 1. 计算淹没总面积
            flood_area = flood_mask.multiply(pixel_area_km2).reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=region,
                scale=100,
                maxPixels=1e9,
                bestEffort=True
            ).getInfo()
            
            # 获取第一个有效的值（波段名可能是 'water' 或其他）
            flood_area_value = 0
            if flood_area:
                for key in flood_area:
                    if flood_area[key] is not None:
                        flood_area_value = flood_area[key]
                        break
            
            results["flood_area"] = {
                "value": round(flood_area_value, 2),
                "unit": "km²",
                "description": "洪水淹没总面积"
            }
            
            # 2. 受影响人口估计 (WorldPop)
            population = self._assess_population_impact(flood_mask, region, peek_date)
            results["population"] = population
            
            # 3. 土地覆盖影响分析 (ESA WorldCover)
            landcover = self._assess_landcover_impact(flood_mask, region)
            results["landcover"] = landcover
            
            # 4. 城市区域影响 (GHSL)
            urban = self._assess_urban_impact(flood_mask, region)
            results["urban"] = urban
            
            # 5. 生成影响可视化图层
            impact_layers = self._generate_impact_layers(flood_mask, region)
            results["layers"] = impact_layers
            
            return results
            
        except Exception as e:
            print(f"Flood impact assessment failed: {e}")
            return {"error": str(e)}
    
    def _assess_population_impact(
        self,
        flood_mask: ee.Image,
        region: ee.Geometry,
        year: str
    ) -> Dict[str, Any]:
        """
        评估受影响人口 - 使用 WorldPop 数据
        
        WorldPop 提供100m分辨率的人口密度数据
        """
        try:
            # 获取年份
            target_year = int(year[:4]) if year else 2020
            # WorldPop数据最新到2020年
            data_year = min(target_year, 2020)
            
            # WorldPop 人口密度数据
            population = ee.ImageCollection("WorldPop/GP/100m/pop") \
                .filterDate(f"{data_year}-01-01", f"{data_year}-12-31") \
                .filterBounds(region) \
                .mosaic() \
                .clip(region)
            
            # 计算淹没区域内的人口总数
            # flood_mask 先转为单波段图像并重命名
            flood_mask_renamed = flood_mask.rename('mask')
            affected_population = flood_mask_renamed.multiply(population).reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=region,
                scale=100,
                maxPixels=1e9,
                bestEffort=True
            ).getInfo()
            
            # 计算区域总人口
            total_population = population.reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=region,
                scale=100,
                maxPixels=1e9,
                bestEffort=True
            ).getInfo()
            
            # 获取第一个有效的值
            affected = 0
            if affected_population:
                for key in affected_population:
                    if affected_population[key] is not None:
                        affected = affected_population[key]
                        break
            
            total = 0
            if total_population:
                for key in total_population:
                    if total_population[key] is not None:
                        total = total_population[key]
                        break
            
            return {
                "affected": round(affected),
                "total": round(total),
                "percentage": round((affected / total * 100) if total > 0 else 0, 2),
                "unit": "人",
                "data_source": f"WorldPop {data_year}",
                "description": "受洪水影响的估计人口"
            }
            
        except Exception as e:
            print(f"人口影响评估失败: {e}")
            return {"error": str(e)}
    
    def _assess_landcover_impact(
        self,
        flood_mask: ee.Image,
        region: ee.Geometry
    ) -> Dict[str, Any]:
        """
        评估土地覆盖影响 - 使用 ESA WorldCover 2021
        
        分类:
        10: 树木覆盖
        20: 灌木
        30: 草地
        40: 农田
        50: 建成区
        60: 裸地/稀疏植被
        70: 雪和冰
        80: 永久水体
        90: 草本湿地
        95: 红树林
        100: 苔藓和地衣
        """
        try:
            # ESA WorldCover 2021
            worldcover = ee.ImageCollection("ESA/WorldCover/v200") \
                .first() \
                .clip(region)
            
            pixel_area_km2 = ee.Image.pixelArea().divide(1e6)
            
            # 土地覆盖类型映射
            landcover_classes = {
                40: {"name": "农田", "name_en": "Cropland"},
                50: {"name": "建成区", "name_en": "Built-up"},
                10: {"name": "森林", "name_en": "Forest"},
                30: {"name": "草地", "name_en": "Grassland"},
                20: {"name": "灌木", "name_en": "Shrubland"},
                90: {"name": "湿地", "name_en": "Wetland"},
            }
            
            results = {}
            
            for class_value, class_info in landcover_classes.items():
                # 创建该类型的掩膜
                class_mask = worldcover.eq(class_value)
                # 计算该类型在淹没区的面积
                # 重命名 flood_mask 避免波段名冲突
                flood_mask_renamed = flood_mask.rename('flood')
                affected_area = flood_mask_renamed.multiply(class_mask).multiply(pixel_area_km2).reduceRegion(
                    reducer=ee.Reducer.sum(),
                    geometry=region,
                    scale=100,
                    maxPixels=1e9,
                    bestEffort=True
                ).getInfo()
                
                # 获取第一个有效的值
                area = 0
                if affected_area:
                    for key in affected_area:
                        if affected_area[key] is not None:
                            area = affected_area[key]
                            break
                
                if area > 0.01:  # 只记录大于0.01平方公里的
                    results[class_info["name_en"].lower()] = {
                        "name": class_info["name"],
                        "area_km2": round(area, 2),
                        "unit": "km²"
                    }
            
            return {
                "breakdown": results,
                "data_source": "ESA WorldCover 2021",
                "description": "受影响土地覆盖类型分布"
            }
            
        except Exception as e:
            print(f"土地覆盖影响评估失败: {e}")
            return {"error": str(e)}
    
    def _assess_urban_impact(
        self,
        flood_mask: ee.Image,
        region: ee.Geometry
    ) -> Dict[str, Any]:
        """
        评估城市区域影响 - 使用 GHSL (Global Human Settlement Layer)
        
        GHSL 提供建成区的详细分类
        """
        try:
            pixel_area_km2 = ee.Image.pixelArea().divide(1e6)
            
            # GHSL Built-up Surface 2020
            ghsl = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2020") \
                .select("built_surface") \
                .clip(region)
            
            # GHSL值 > 0 表示有建成区
            built_mask = ghsl.gt(0)
            
            # 重命名 flood_mask 避免波段名冲突
            flood_mask_renamed = flood_mask.rename('flood')
            
            # 计算淹没的建成区面积
            affected_built = flood_mask_renamed.multiply(built_mask).multiply(pixel_area_km2).reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=region,
                scale=100,
                maxPixels=1e9,
                bestEffort=True
            ).getInfo()
            
            # 计算区域内总建成区面积
            total_built = built_mask.multiply(pixel_area_km2).reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=region,
                scale=100,
                maxPixels=1e9,
                bestEffort=True
            ).getInfo()
            
            # 获取第一个有效的值
            affected = 0
            if affected_built:
                for key in affected_built:
                    if affected_built[key] is not None:
                        affected = affected_built[key]
                        break
            
            total = 0
            if total_built:
                for key in total_built:
                    if total_built[key] is not None:
                        total = total_built[key]
                        break
            
            return {
                "affected_area_km2": round(affected, 2),
                "total_area_km2": round(total, 2),
                "percentage": round((affected / total * 100) if total > 0 else 0, 2),
                "unit": "km²",
                "data_source": "GHSL 2020",
                "description": "受影响的建成区面积"
            }
            
        except Exception as e:
            print(f"城市影响评估失败: {e}")
            return {"error": str(e)}
    
    def _generate_impact_layers(
        self,
        flood_mask: ee.Image,
        region: ee.Geometry
    ) -> Dict[str, Any]:
        """
        生成损失评估可视化图层
        """
        try:
            layers = {}
            
            # 1. 人口密度图层
            population = ee.ImageCollection("WorldPop/GP/100m/pop") \
                .filterDate("2020-01-01", "2020-12-31") \
                .filterBounds(region) \
                .mosaic() \
                .clip(region)
            
            # 只显示淹没区域内的人口
            affected_pop = population.updateMask(flood_mask)
            
            pop_vis = {
                "min": 0,
                "max": 1000,
                "palette": ["yellow", "orange", "red", "darkred"]
            }
            
            pop_map_id = affected_pop.getMapId(pop_vis)
            layers["population"] = {
                "tile_url": pop_map_id["tile_fetcher"].url_format,
                "name": "受影响人口密度",
                "legend": "黄-红: 人口密度低-高"
            }
            
            # 2. 土地覆盖影响图层
            worldcover = ee.ImageCollection("ESA/WorldCover/v200") \
                .first() \
                .clip(region)
            
            # 只显示淹没区域的土地覆盖
            affected_lc = worldcover.updateMask(flood_mask)
            
            lc_vis = {
                "bands": ["Map"],
                "min": 10,
                "max": 100,
                "palette": [
                    "006400",  # 10 森林 - 深绿
                    "ffbb22",  # 20 灌木 - 橙黄
                    "ffff4c",  # 30 草地 - 黄
                    "f096ff",  # 40 农田 - 粉紫
                    "fa0000",  # 50 建成区 - 红
                    "b4b4b4",  # 60 裸地 - 灰
                    "f0f0f0",  # 70 雪冰 - 白
                    "0064c8",  # 80 水体 - 蓝
                    "0096a0",  # 90 湿地 - 青
                    "00cf75",  # 95 红树林 - 绿
                    "fae6a0",  # 100 苔藓 - 米黄
                ]
            }
            
            lc_map_id = affected_lc.getMapId(lc_vis)
            layers["landcover"] = {
                "tile_url": lc_map_id["tile_fetcher"].url_format,
                "name": "受影响土地覆盖",
                "legend": "红=建成区, 粉紫=农田, 绿=森林"
            }
            
            # 3. 建成区影响图层
            ghsl = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2020") \
                .select("built_surface") \
                .clip(region)
            
            affected_urban = ghsl.updateMask(flood_mask).updateMask(ghsl.gt(0))
            
            urban_vis = {
                "min": 0,
                "max": 10000,
                "palette": ["ffeda0", "feb24c", "f03b20"]
            }
            
            urban_map_id = affected_urban.getMapId(urban_vis)
            layers["urban"] = {
                "tile_url": urban_map_id["tile_fetcher"].url_format,
                "name": "受影响建成区",
                "legend": "黄-红: 建筑密度低-高"
            }
            
            return layers
            
        except Exception as e:
            print(f"生成影响图层失败: {e}")
            return {"error": str(e)}
    
    def get_flood_impact_by_geojson(
        self,
        pre_date: str,
        peek_date: str,
        geojson: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        基于 GeoJSON 区域进行洪水损失评估
        
        完整流程:
        1. 获取洪水变化检测结果
        2. 进行损失评估
        3. 返回综合结果
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            # 处理不同的 GeoJSON 格式
            geometry_data = geojson
            if geojson.get("type") == "FeatureCollection":
                # 从 FeatureCollection 提取第一个 Feature 的 geometry
                features = geojson.get("features", [])
                if features:
                    geometry_data = features[0].get("geometry", geojson)
                else:
                    return {"error": "No features found in FeatureCollection"}
            elif geojson.get("type") == "Feature":
                # 从 Feature 提取 geometry
                geometry_data = geojson.get("geometry", geojson)
            
            region = ee.Geometry(geometry_data)
            
            # 1. 获取洪水掩膜 - 使用统一的Otsu变化检测方法
            # 确保两个时期的影像时间窗口不重叠
            pre_image = self._get_sar_composite(pre_date, region, 15, search_direction="before")
            peek_image = self._get_sar_composite(peek_date, region, 15, search_direction="after")
            
            if pre_image is None or peek_image is None:
                return {"error": "Insufficient SAR imagery for analysis"}
            
            # 使用标准Otsu变化检测方法（与洪水检测面板保持一致）
            vv_pre = pre_image.select("VV")
            vv_peek = peek_image.select("VV")
            change_index = vv_peek.subtract(vv_pre).rename("change")
            
            # 对变化指数应用Otsu阈值（检测变化区域）
            flood_by_change = self._otsu_change_detection(change_index, region)
            
            # 同时检测洪峰期水体（确保不漏掉）
            peek_water = self._otsu_water_detection(peek_image, region)
            
            # 使用 JRC 排除永久水体（与洪水检测保持一致）
            # 只排除真正的永久水体（occurrence >= 95）
            jrc = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").clip(region)
            permanent_water = jrc.select("occurrence").gte(95)
            
            # 洪水淹没区 = (变化检测结果 OR 洪峰期水体) AND 不是永久水体
            flood_mask = (flood_by_change.Or(peek_water)).And(permanent_water.Not())
            
            # 2. 进行损失评估
            assessment = self.get_flood_impact_assessment(
                flood_mask, region, pre_date, peek_date
            )
            
            return assessment
            
        except Exception as e:
            return {"error": f"Flood impact assessment failed: {str(e)}"}
    
    def get_flood_impact_by_bounds(
        self,
        pre_date: str,
        peek_date: str,
        bounds: Dict[str, float]
    ) -> Dict[str, Any]:
        """
        基于边界框进行洪水损失评估
        """
        if not self.initialized:
            return {"error": "GEE service not initialized"}
        
        try:
            region = ee.Geometry.Rectangle([
                bounds["west"], bounds["south"],
                bounds["east"], bounds["north"]
            ])
            
            # 转换为 GeoJSON 格式调用
            geojson = region.getInfo()
            return self.get_flood_impact_by_geojson(pre_date, peek_date, geojson)
            
        except Exception as e:
            return {"error": f"Flood impact assessment failed: {str(e)}"}


# 创建全局实例
gee_service = GEEService()


def get_flood_images(
    pre_date: str,
    peek_date: str,
    after_date: str,
    longitude: float,
    latitude: float
) -> Dict[str, Any]:
    """
    便捷函数：获取洪水影像
    """
    return gee_service.get_flood_imagery(
        pre_date=pre_date,
        peek_date=peek_date,
        after_date=after_date,
        center=(longitude, latitude)
    )
