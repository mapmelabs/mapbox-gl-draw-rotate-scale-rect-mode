import MapboxDraw from '@mapbox/mapbox-gl-draw';

import Constants from '@mapbox/mapbox-gl-draw/src/constants';
import doubleClickZoom from '@mapbox/mapbox-gl-draw/src/lib/double_click_zoom';
import createSupplementaryPoints from '@mapbox/mapbox-gl-draw/src/lib/create_supplementary_points';
import CommonSelectors from '@mapbox/mapbox-gl-draw/src/lib/common_selectors';
import moveFeatures from '@mapbox/mapbox-gl-draw/src/lib/move_features';

import * as turf from '@turf/turf';

export const TxRectMode = {};

TxRectMode.toDisplayFeatures = function(state, geojson, push) {
    if (state.featureId === geojson.properties.id) {
        geojson.properties.active = Constants.activeStates.ACTIVE;
        push(geojson);
        var suppPoints = createSupplementaryPoints(geojson, {
            map: this.map,
            midpoints: false,
            selectedPaths: state.selectedCoordPaths
        });
        this.computeBisectrix(suppPoints);
        var rotPoints = this.createRotationPoints(geojson, suppPoints);
        suppPoints.forEach(push);
        rotPoints.forEach(push);
    } else {
        geojson.properties.active = Constants.activeStates.INACTIVE;
        push(geojson);
    }

    // this.fireActionable(state);
    this.setActionableState({
        combineFeatures: false,
        uncombineFeatures: false,
        trash: false
    });
};

TxRectMode.onSetup = function(opts) {
    const featureId = opts.featureId;
    const feature = this.getFeature(featureId);

    if (!feature) {
        throw new Error('You must provide a featureId to enter direct_select mode');
    }

    if (feature.type != Constants.geojsonTypes.POLYGON) {
        throw new TypeError('tx_rect mode doesn\'t handle only rectangles');
    }
    if (feature.coordinates === undefined
        || feature.coordinates.length != 1
        || feature.coordinates[0].length != 4) {
        throw new TypeError('tx_rect mode doesn\'t handle only rectangles');
    }

    const state = {
        featureId,
        feature,
        dragMoveLocation: opts.startPos || null,
        dragMoving: false,
        canDragMove: false,
        selectedCoordPaths: opts.coordPath ? [opts.coordPath] : []
    };
    
    this.setSelectedCoordinates(this.pathsToCoordinates(featureId, state.selectedCoordPaths));
    this.setSelected(featureId);
    doubleClickZoom.disable(this);

    this.setActionableState({
        trash: true
    });

    return state;
};

TxRectMode.onStop = function() {
    doubleClickZoom.enable(this);
    this.clearSelectedCoordinates();
};

// TODO why I need this?
TxRectMode.pathsToCoordinates = function(featureId, paths) {
    return paths.map(coord_path => { return { feature_id: featureId, coord_path }; });
};

TxRectMode.computeBisectrix = function(points) {
    for (var i1 = 0; i1 < points.length; i1++) {
        var i0 = (i1 - 1 + points.length) % points.length;
        var i2 = (i1 + 1) % points.length;
        // console.log('' + i0 + ' -> ' + i1 + ' -> ' + i2);

        var l1 = turf.lineString([points[i0].geometry.coordinates, points[i1].geometry.coordinates]);
        var l2 = turf.lineString([points[i1].geometry.coordinates, points[i2].geometry.coordinates]);
        var a1 = turf.bearing(points[i0].geometry.coordinates, points[i1].geometry.coordinates);
        var a2 = turf.bearing(points[i2].geometry.coordinates, points[i1].geometry.coordinates);
        // console.log('a1 = '  +a1 + ', a2 = ' + a2);

        var a = (a1 + a2)/2.0;

        if (a < 0.0)
            a += 360;
        if (a > 360)
            a -= 360;

        points[i1].properties.heading = a;
    }

};

TxRectMode.createRotationPoints = function(geojson, suppPoints) {
    const { type, coordinates } = geojson.geometry;
    const featureId = geojson.properties && geojson.properties.id;

    let rotationWidgets = [];
    if (type != Constants.geojsonTypes.POLYGON) {
        return ;
    }

    var corners = suppPoints.slice(0);
    corners[corners.length] = corners[0];

    var v1 = null;
    corners.forEach((v2) => {
        if (v1 != null) {
            var center = turf.centroid(geojson);
            var cR0 = turf.midpoint(v1, v2).geometry.coordinates;

            var heading = turf.bearing(center, cR0);
            var distance0 = turf.distance(center, cR0);
            var distance1 = 1.0 * distance0; // TODO paramter, TODO depends on map scale
            var cR1 = turf.destination(center, distance0, heading, {}).geometry.coordinates;

            rotationWidgets.push({
                    type: Constants.geojsonTypes.FEATURE,
                    properties: {
                        meta: Constants.meta.MIDPOINT,
                        parent: featureId,
                        lng: cR1[0],
                        lat: cR1[1],
                        coord_path: v1.properties.coord_path,
                        heading: heading,
                    },
                    geometry: {
                        type: Constants.geojsonTypes.POINT,
                        coordinates: cR1
                    }
                }
            );

            // rotationWidgets.push({
            //         type: Constants.geojsonTypes.FEATURE,
            //         properties: {
            //             meta: Constants.meta.MIDPOINT,
            //             parent: featureId,
            //             // lng: cR1[0],
            //             // lat: cR1[1],
            //             coord_path: v1.properties.coord_path
            //         },
            //         geometry: {
            //             type: Constants.geojsonTypes.LINE_STRING,
            //             coordinates: [cR0, cR1]
            //         }
            //     }
            // );
        }

        v1 = v2;

    });

    return rotationWidgets;
};

TxRectMode.startDragging = function(state, e) {
    this.map.dragPan.disable();
    state.canDragMove = true;
    state.dragMoveLocation = e.lngLat;
};

TxRectMode.stopDragging = function(state) {
    this.map.dragPan.enable();
    state.dragMoving = false;
    state.canDragMove = false;
    state.dragMoveLocation = null;
};

const isRotatePoint = CommonSelectors.isOfMetaType(Constants.meta.MIDPOINT);
const isVertex = CommonSelectors.isOfMetaType(Constants.meta.VERTEX);

TxRectMode.onTouchStart = TxRectMode.onMouseDown = function(state, e) {
    if (isVertex(e)) return this.onVertex(state, e);
    if (isRotatePoint(e)) return this.onRotatePoint(state, e);
    if (CommonSelectors.isActiveFeature(e)) return this.onFeature(state, e);
    // if (isMidpoint(e)) return this.onMidpoint(state, e);
};


const TX_MODE_SCALE = "tx.scale";
const TX_MODE_ROTATE = "tx.rotate";

TxRectMode.onVertex = function(state, e) {
    // console.log('onVertex()');
    // convert internal MapboxDraw feature to valid GeoJSON:
    this.computeAxes(state.feature.toGeoJSON(), state);

    this.startDragging(state, e);
    const about = e.featureTarget.properties;
    state.selectedCoordPaths = [about.coord_path];
    state.txMode = TX_MODE_SCALE;
};

TxRectMode.onRotatePoint = function(state, e) {
    // console.log('onRotatePoint()');
    // convert internal MapboxDraw feature to valid GeoJSON:
    this.computeAxes(state.feature.toGeoJSON(), state);

    this.startDragging(state, e);
    const about = e.featureTarget.properties;
    state.selectedCoordPaths = [about.coord_path];
    state.txMode = TX_MODE_ROTATE;
};

TxRectMode.onFeature = function(state, e) {
    state.selectedCoordPaths = [];
    this.startDragging(state, e);
};

TxRectMode.computeAxes = function(polygon, state) {
    // TODO check min 3 points
    var center = turf.centroid(polygon);

    var rotPoint = turf.midpoint(
        turf.point(polygon.geometry.coordinates[0][0]),
        turf.point(polygon.geometry.coordinates[0][1]));
    var heading = turf.bearing(center, rotPoint);

    state.rotation = {
        feature0: polygon,  // initial feature state
        center: center.geometry.coordinates,
        heading0: heading // rotation start heading
    };

    // compute current distances from center for scaling
    var distances = polygon.geometry.coordinates[0].map((c) =>
        turf.distance(center, turf.point(c), { units: 'meters'}) );

    state.scaling = {
        feature0: polygon,  // initial feature state
        center: center.geometry.coordinates,
        distances: distances
    };
};

TxRectMode.onDrag = function(state, e) {
    if (state.canDragMove !== true) return;
    state.dragMoving = true;
    e.originalEvent.stopPropagation();

    const delta = {
        lng: e.lngLat.lng - state.dragMoveLocation.lng,
        lat: e.lngLat.lat - state.dragMoveLocation.lat
    };
    if (state.selectedCoordPaths.length > 0 && state.txMode) {
        switch (state.txMode) {
            case TX_MODE_ROTATE:
                this.dragRotatePoint(state, e, delta);
                break;
            case TX_MODE_SCALE:
                this.dragScalePoint(state, e, delta);
                break;
        }
    } else {
        this.dragFeature(state, e, delta);
    }


    state.dragMoveLocation = e.lngLat;
};

TxRectMode.dragRotatePoint = function(state, e, delta) {
    // console.log('dragRotateVertex: ' + e.lngLat + ' -> ' + state.dragMoveLocation);

    if (state.rotation === undefined || state.rotation == null) {
        console.error('state.rotation required');
        return ;
    }

    var polygon = state.feature.toGeoJSON();
    var m1 = turf.point([e.lngLat.lng, e.lngLat.lat]);
    var heading1 = turf.bearing(turf.point(state.rotation.center), m1);

    var rotateAngle = heading1 - state.rotation.heading0; // in degrees
    if (CommonSelectors.isShiftDown(e)) {
        rotateAngle = 5.0 * Math.round(rotateAngle / 5.0);
    }

    var rotatedFeature = turf.transformRotate(state.rotation.feature0,
        rotateAngle,
        {
           pivot: state.rotation.center,
            mutate: false,
        });

    state.feature.incomingCoords(rotatedFeature.geometry.coordinates);
    // TODO add option for this:
    this.fireUpdate();
};

TxRectMode.dragScalePoint = function(state, e, delta) {
    if (state.scaling === undefined || state.scaling == null) {
        console.error('state.scaling required');
        return ;
    }

    var polygon = state.feature.toGeoJSON();

    var center = turf.point(state.scaling.center);
    var m1 = turf.point([e.lngLat.lng, e.lngLat.lat]);

    var distance = turf.distance(center, m1, { units: 'meters'});
    var scale = distance / state.scaling.distances[0]; // TODO fix index

    if (CommonSelectors.isShiftDown(e)) {
        // TODO discrete scaling
        scale = 0.05 * Math.round(scale / 0.05);
    }

    var scaledFeature = turf.transformScale(state.scaling.feature0,
        scale,
        {
            origin: state.scaling.center,
            mutate: false,
        });

    state.feature.incomingCoords(scaledFeature.geometry.coordinates);
    // TODO add option for this:
    this.fireUpdate();
};

TxRectMode.dragFeature = function(state, e, delta) {
    moveFeatures(this.getSelected(), delta);
    state.dragMoveLocation = e.lngLat;
    // TODO add option for this:
    this.fireUpdate();
};

TxRectMode.fireUpdate = function() {
    this.map.fire(Constants.events.UPDATE, {
        action: Constants.updateActions.CHANGE_COORDINATES,
        features: this.getSelected().map(f => f.toGeoJSON())
    });
};

TxRectMode.onMouseOut = function(state) {
    // As soon as you mouse leaves the canvas, update the feature
    if (state.dragMoving) {
        this.fireUpdate();
    }
};

TxRectMode.onTouchEnd = TxRectMode.onMouseUp = function(state) {
    if (state.dragMoving) {
        this.fireUpdate();
    }
    this.stopDragging(state);
};

TxRectMode.clickActiveFeature = function (state) {
    state.selectedCoordPaths = [];
    this.clearSelectedCoordinates();
    state.feature.changed();
};

TxRectMode.onClick = function(state, e) {
    if (CommonSelectors.noTarget(e)) return this.clickNoTarget(state, e);
    if (CommonSelectors.isActiveFeature(e)) return this.clickActiveFeature(state, e);
    if (CommonSelectors.isInactiveFeature(e)) return this.clickInactive(state, e);
    this.stopDragging(state);
};

TxRectMode.clickNoTarget = function () {
    // this.changeMode(Constants.modes.SIMPLE_SELECT);
};

TxRectMode.clickInactive = function () {
    // this.changeMode(Constants.modes.SIMPLE_SELECT);
};
