package nl.eigencloud.core;

import java.io.File;
import java.nio.file.Files;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Against a REAL running Node cluster node (scripts/android-cluster-node.ts; info file via CLUSTER_INFO):
 * rpc status, findLeader, clusterStatus/clusterSummary, signed jobs (adminProof + Json compatibility with the
 * leader's verifyAdminProof), setPolicy and pushAdminConfig, manifest from the node's own storage.
 */
public class ClusterRpcTest {
    public static void main(String[] args) {
        T.main("ClusterRpcTest", () -> {
            String infoPath = T.env("CLUSTER_INFO");
            if (infoPath == null) throw new IllegalStateException("CLUSTER_INFO niet gezet");
            Map<String, Object> info = Json.parseObject(new String(Files.readAllBytes(new File(infoPath).toPath()), "UTF-8"));
            String url = Json.str(info, "clusterUrl");
            Map<String, Object> cfg = Json.map(info, "config");
            ClusterConfig.Keys keys = ClusterConfig.keysFor(cfg);

            Map<String, Object> st = Transport.rpcObject(keys.cluster, url, Json.obj("type", "status"), 3000);
            T.eq("leader", st.get("role"), "rpc status → leader");
            T.eq("n-first", st.get("id"), "node id");

            T.throwsWith("RPC", () -> Transport.rpc(EigenCrypto.deriveKey(keys.master, "verkeerd"), url, Json.obj("type", "status"), 3000), "wrong cluster key refused by node");

            Admin.Leader leader = Admin.findLeader(cfg, Collections.singletonList(url));
            T.check(leader != null && url.equals(leader.url), "findLeader");
            T.check(Admin.findLeader(cfg, Collections.singletonList("http://127.0.0.1:1")) == null, "findLeader with dead URL → null");

            Admin.Status status = Admin.clusterStatus(cfg, Collections.singletonList(url));
            T.eq(url, status.leaderUrl, "clusterStatus leaderUrl");
            T.check(status.live != null && Boolean.TRUE.equals(status.live.get("leader")), "clusterSummary from leader");
            List<Object> nodes = Json.listAt(status.live, "nodes");
            T.check(!nodes.isEmpty(), "clusterSummary has nodes");
            T.eq("n-first", Json.str(nodes.get(0), "id"), "first node listed");
            T.eq("awake", Console.state(status, false), "dashboard state");

            Map<String, Object> job = Admin.sendJob(cfg, url, "snapshot", Json.obj());
            T.eq(Boolean.TRUE, job.get("ok"), "sendJob snapshot → ok:true (proof accepted by the Node leader): " + Json.stringify(job));
            String id = Json.str(job, "id");
            T.check(id != null && !id.isEmpty(), "job id");

            Map<String, Object> drill = Admin.sendJob(cfg, url, "drill", Json.obj("note", "ü \"quote\"   😀", "n", 0.1, "big", 1e21, "nested", Json.obj("2", 1, "1", 2, "list", Json.list(null, true, "\ud800"))));
            T.eq(Boolean.TRUE, drill.get("ok"), "signed job with nasty params accepted: " + Json.stringify(drill));
            Map<String, Object> unknown = Admin.sendJob(cfg, url, "formatteer", Json.obj());
            T.eq("onbekende job", unknown.get("error"), "unknown job refused");

            // Tampered proof: signature over another payload.
            Map<String, Object> payload = Json.obj("type", "snapshot", "params", Json.obj());
            Map<String, Object> forged = Json.obj("type", "adminJob", "job", payload, "proof", Admin.adminProof(Json.str(cfg, "masterKey"), Json.obj("type", "sleep", "params", Json.obj())));
            T.eq("niet ondertekend", Transport.rpcObject(keys.cluster, url, forged, 5000).get("error"), "forged proof refused");

            Map<String, Object> pol = Admin.setPolicy(cfg, url, Json.obj("autoReplaceAfterMin", 20, "autoHeal", false));
            T.eq(Boolean.TRUE, pol.get("ok"), "setPolicy accepted");

            Map<String, Object> admin = Json.copy(cfg);
            admin.put("console", Json.obj("mailRelay", "smtp://rene%40test.nl:p%40ss@relay.example.org:587", "spfExtra", "include:_spf.example.org", "alertEmail", "melding@example.org"));
            T.check(Admin.pushAdminConfig(admin), "pushAdminConfig accepted (signed update with stores/providers/dns/placement)");

            // Wait for the snapshot job to finish; the leader then writes the manifest to its storage.
            String jobStatus = null;
            Map<String, Object> m = null;
            for (int i = 0; i < 120 && (jobStatus == null || m == null || !"done".equals(jobStatus)); i++) {
                Map<String, Object> sum = Transport.rpcObject(keys.cluster, url, Json.obj("type", "clusterSummary"), 5000);
                for (Object j : Json.listAt(sum, "jobs")) if (id.equals(Json.str(j, "id"))) jobStatus = Json.str(j, "status");
                if ("failed".equals(jobStatus)) break;
                m = Admin.readManifest(cfg);
                Thread.sleep(500);
            }
            T.eq("done", jobStatus, "snapshot job finished");
            T.check(m != null, "manifest written by the Node leader is readable in Java");
            if (m != null) {
                T.eq("test", m.get("cluster"), "manifest cluster");
                T.eq(Collections.singletonList("n-first"), Admin.probeCluster(cfg, m), "probeCluster");
                Admin.Status full = Admin.clusterStatus(cfg);
                T.eq(url, full.leaderUrl, "clusterStatus finds leader via manifest only");
            }
        });
    }
}
