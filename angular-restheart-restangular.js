var module = angular.module('restheart', [
    'LocalStorageModule',
    'base64',
    'restangular'
]);

module.config(['localStorageServiceProvider', 'RestangularProvider',
    function (localStorageServiceProvider, RestangularProvider) {
        localStorageServiceProvider.setStorageType('sessionStorage');
        RestangularProvider.setRestangularFields({
            id: "_id",
            etag: "_etag",
            selfLink: "_links['self'].href"
            //parentResource: "_links['XXXX'].href" XXXX= rh:bucket | rh:coll
        });
        RestangularProvider.addResponseInterceptor(function (data, operation, what, url, response, deferred) {
            var extractedData;
            if (operation === "getList") {
                if (angular.isDefined(data._embedded['rh:doc'])) {
                    extractedData = data._embedded['rh:doc'];
                } else if (angular.isDefined(data._embedded['rh:file'])) {
                    extractedData = data._embedded['rh:file'];
                } else {
                    extractedData = [];
                }

                if (angular.isDefined(data._embedded['rh:warnings'])) {
                    extractedData._warnings = data._embedded['rh:warnings'];
                }

                extractedData._returned = data._returned;
                extractedData._size = data._size;
                extractedData._total_pages = data._total_pages;
                extractedData._links = data._links;
            } else {
                extractedData = data;
            }

            return extractedData;
        });
        RestangularProvider.setDefaultHeaders({
            'Accept': 'application/hal+json',
            'Content-Type': 'application/json',
            'No-Auth-Challenge': 'true'
        });
    }])

module.provider('restheart', function () {
    
    this.setBaseUrl = function (f) {
        this.baseUrl = f;
    };

    this.setLogicBaseUrl = function (f) {
        this.logicBaseUrl = f;
    };

    this.onForbidden = function (f) {
        this.onForbidden = f;
    };

    this.onTokenExpired = function (f) {
        this.onTokenExpired = f;
    };

    this.onUnauthenticated = function (f) {
        this.onUnauthenticated = f;
    };

    this.$get = function () {
        return this;
    };

})


module.service('RhAuth', ['$base64', '$http', 'localStorageService', 'RhLogic', '$q',  'Rh',
    function ($base64, $http, localStorageService, RhLogic, $q, Rh) {

        this.setAuthHeader = function (userid, password) {
            $http.defaults.headers.common["Authorization"] = 'Basic ' + $base64.encode(userid + ":" + password);
        };

        this.saveAuthInfo = function (userid, password, roles) {
            var header = $base64.encode(userid + ":" + password);
            localStorageService.set('userid', userid);
            localStorageService.set('authtoken', header);
            localStorageService.set('nav', $base64.encode(JSON.stringify(roles)));
            return header;
        };

        this.clearAuthInfo = function () {
            var restheartUrl = localStorageService.get('restheartUrl');
            var redirected = localStorageService.get('redirected');

            localStorageService.clearAll();

            // avoid restheartUrl to be deleted
            localStorageService.set('restheartUrl', restheartUrl);

            // avoid redirected to be deleted
            localStorageService.set('redirected', redirected);

            if (!angular.isUndefined($http) && !angular.isUndefined($http.defaults)) {
                delete $http.defaults.headers.common["Authorization"];
            }
        };

        this.getAuthHeader = function () {
            return localStorageService.get('authtoken');
        };

        this.getUserid = function () {
            return localStorageService.get('userid');
        };

        this.getUserRoles = function () {
            var _nav = localStorageService.get('nav');
            return JSON.parse($base64.decode(_nav));
        };

        this.isAuthenticated = function () {
            var authHeader = this.getAuthHeader(localStorageService);
            return !(angular.isUndefined(authHeader) || authHeader === null);
        };

        this.signin = function (id, password) {
            var that = this;
            return $q(function (resolve, reject) {
                that.clearAuthInfo();
                that.setAuthHeader(id, password);
                var apiOptions = {
                    nocache: new Date().getTime()
                };

                RhLogic.one('roles', id)
                    .get(apiOptions)
                    .then(function (userRoles) {
                        var authToken = userRoles.headers('Auth-Token');
                        if (authToken === null) {
                            that.clearAuthInfo();
                            resolve(false);
                        }
                        that.saveAuthInfo(id, authToken, userRoles.data.roles);
                        that.setAuthHeader(id, authToken);
                        resolve(true);

                    },
                    function errorCallback(response) {
                        that.clearAuthInfo();
                        resolve(false);

                    });
            })
        };

        this.signout = function (removeTokenFromDB) {
            var that = this;
            return $q(function (resolve, reject) {
                if (removeTokenFromDB) {
                    var userid = localStorageService.get('userid');
                    Rh.one('_authtokens', userid).remove().then(function () {
                        that.clearAuthInfo();
                        resolve(true);
                    }, function errorCallback(response) {
                        that.clearAuthInfo();
                        resolve(false);
                    });
                }
                else {
                    this.clearAuthInfo();
                    resolve(true);
                }
            })
        }
    }]);

// Restangular service for authentication
module.factory('RhLogic', ['Restangular', 'localStorageService', '$location', 'restheart',
    function (Restangular, localStorageService, $location, restheart) {
        return Restangular.withConfig(function (RestangularConfigurer) {
            RestangularConfigurer.setFullResponse(true);

            var baseUrl = restheart.logicBaseUrl;

            if (angular.isDefined(baseUrl) && baseUrl !== null) {
                RestangularConfigurer.setBaseUrl(baseUrl);
            } else { //default configuration
                var _restheartUrl;
                _restheartUrl = "http://" + $location.host() + ":8080/_logic";
                RestangularConfigurer.setBaseUrl(_restheartUrl);

            }
            RestangularConfigurer.setErrorInterceptor(function (response, deferred, responseHandler) {
                // check if session expired
                var f = handleUnauthenticated(response);
                return !f; // if handled --> false
            });

            function handleUnauthenticated(response) {
                if (response.status === 401) {
                    localStorageService.set('Error 401', {
                        'why': 'wrong credentials',
                        'from': $location.path()
                    });
                    restheart.onUnauthenticated();
                    return true; // handled
                }

                return false; // not handled
            }
        });
    }])

// Restangular service for API calling
// also handles auth token expiration
module.factory('Rh', ['Restangular', 'localStorageService', '$location', 'restheart', '$http',
    function (Restangular, localStorageService, $location, restheart, $http) {
        return Restangular.withConfig(function (RestangularConfigurer) {

            var baseUrl = restheart.baseUrl;

            if (angular.isDefined(baseUrl) && baseUrl !== null) {
                RestangularConfigurer.setBaseUrl(baseUrl);
            }
            else { //default configuration
                var _restheartUrl;
                _restheartUrl = "http://" + $location.host() + ":8080";
                localStorageService.set("restheartUrl", _restheartUrl);
                RestangularConfigurer.setBaseUrl(_restheartUrl);

            }

            RestangularConfigurer.setErrorInterceptor(function (response, deferred, responseHandler) {
                // check if session expired
                var te = handleTokenExpiration(response);
                var f = handleForbidden(response);
                return !(te || f); // if handled --> false
            });

            RestangularConfigurer.setRequestInterceptor(function (elem, operation) {
                setAuthHeaderFromLS();
                return elem;
            });

            function setAuthHeaderFromLS() {
                var token = localStorageService.get('authtoken');
                if (angular.isDefined(token) && token !== null) {
                    $http.defaults.headers.common["Authorization"] = 'Basic ' + localStorageService.get('authtoken');
                }
            };

            function handleTokenExpiration(response) {
                var token = localStorageService.get('authtoken');
                if (response.status === 401 && angular.isDefined(token) && token !== null) {
                    //if (response.status === 401 && RhAuth.isAuthenticated()) {
                    // UNAUTHORIZED but signed in => auth token expired
                    //RhAuth.clearAuthInfo();

                    localStorageService.set('Error 401', {
                        "why": "expired",
                        "from": $location.path(),
                        "params": routeParams
                    });
                    restheart.onTokenExpired();
                    return true; // handled
                }
                return false; // not handled
            }

            function handleForbidden(response) {
                if (response.status === 403) {
                    var token = localStorageService.get('authtoken');
                    if (angular.isDefined(token) && token !== null) {
                        localStorageService.set('Error 403', {
                            'why': 'forbidden',
                            'from': $location.path()
                        });
                        restheart.onForbidden();

                    } else {
                        restheart.onUnauthenticated();
                    }

                    return true; // handled
                }

                return false; // not handled
            }
        });
    }]);

// Restangular service for API calling
// with full response (also returns response headers)
module.factory('FRh', ['Rh',
    function (Rh) {
        return Rh.withConfig(function (RestangularConfigurer) {
            RestangularConfigurer.setFullResponse(true);
        });
    }])