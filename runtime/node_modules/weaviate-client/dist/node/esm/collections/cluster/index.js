const cluster = (connection) => {
    return {
        nodes: (opts) => {
            const params = new URLSearchParams();
            let path = '/nodes';
            if (opts?.collection) {
                path = path.concat(`/${opts.collection}`);
            }
            params.append('output', opts?.output ? opts.output : 'minimal');
            return connection
                .get(`${path}?${params.toString()}`)
                .then((res) => res.nodes);
        },
        queryShardingState: (collection, opts) => {
            const params = new URLSearchParams();
            params.append('collection', collection);
            if (opts?.shard) {
                params.append('shard', opts.shard);
            }
            return connection
                .get(`/replication/sharding-state?${params.toString()}`)
                .then((res) => res);
        },
        replicate: (args) => connection
            .postReturn(`/replication/replicate`, (({ replicationType, ...rest }) => ({ type: replicationType, ...rest }))(args))
            .then((res) => res.id),
        replications: {
            cancel: (id) => connection.postEmpty(`/replication/replicate/${id}/cancel`, {}),
            delete: (id) => connection.delete(`/replication/replicate/${id}`, {}, false),
            deleteAll: () => connection.delete(`/replication/replicate`, {}, false),
            get: (id, opts) => connection
                .get(`/replication/replicate/${id}?includeHistory=${opts?.includeHistory ? opts?.includeHistory : 'false'}`)
                .then((res) => (res ? res : null)),
            query: (opts) => {
                const { collection, shard, targetNode, includeHistory } = opts || {};
                const params = new URLSearchParams();
                if (collection) {
                    params.append('collection', collection);
                }
                if (shard) {
                    params.append('shard', shard);
                }
                if (targetNode) {
                    params.append('targetNode', targetNode);
                }
                if (includeHistory) {
                    params.append('includeHistory', includeHistory.toString());
                }
                return connection.get(`/replication/replicate?${params.toString()}`);
            },
        },
    };
};
export default cluster;
